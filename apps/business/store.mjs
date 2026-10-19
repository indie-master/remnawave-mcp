import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const emailAddress = value => typeof value === 'string' && value.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value);
const currencyValid = value => ['RUB', 'USDT'].includes(value);
const unitsValid = value => Number.isSafeInteger(value) && value > 0 && value <= 100000000000;
export const redactSupport = value => String(value).replace(/https?:\/\/\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\b\d{5,20}:[A-Za-z0-9_-]{30,}\b|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\b(?:\d{1,3}\.){3}\d{1,3}\b/gi, '[скрыто]').slice(0, 500);
const normalize = value => redactSupport(value).normalize('NFKC').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

export function createBusinessStore({ filename, now = Date.now, reconciliationEnabled = false, reviewDelayMs = 900000 }) {
    if (typeof reconciliationEnabled !== 'boolean' || !Number.isSafeInteger(reviewDelayMs) || reviewDelayMs < 300000 || reviewDelayMs > 86400000) throw new Error('INVALID_RECONCILIATION_CONFIGURATION');
    const database = new DatabaseSync(filename);
    database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000;
        CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password TEXT NOT NULL, panel_id INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, account TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, account TEXT NOT NULL, currency TEXT NOT NULL, units INTEGER NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, account TEXT NOT NULL, currency TEXT NOT NULL, units INTEGER NOT NULL, created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS manual_receipts (reference TEXT PRIMARY KEY, payment TEXT NOT NULL UNIQUE);
        CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, account TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS knowledge (id TEXT PRIMARY KEY, aliases TEXT NOT NULL, answer TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS private_cache (account TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(account,question));
        CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, account TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS renewal_requests (id TEXT PRIMARY KEY, account TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, currency TEXT NOT NULL, units INTEGER NOT NULL, days INTEGER NOT NULL, proposal TEXT);
        CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS search_cache (key TEXT PRIMARY KEY, result TEXT NOT NULL, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS search_quota (day TEXT PRIMARY KEY, used INTEGER NOT NULL, last INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS media_permissions (account TEXT PRIMARY KEY, question TEXT NOT NULL, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS media_reviews (id TEXT PRIMARY KEY, account TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS renewal_clock (id TEXT PRIMARY KEY, started INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS billing_audit (id INTEGER PRIMARY KEY, operation TEXT NOT NULL, subject TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, note TEXT NOT NULL);
    `);
    database.prepare("INSERT OR IGNORE INTO renewal_clock SELECT id,? FROM renewal_requests WHERE state IN ('executing','uncertain')").run(now());
    const audit = (operation, subject, state, note = '') => database.prepare('INSERT INTO billing_audit(operation,subject,state,created,note) VALUES (?,?,?,?,?)').run(operation, subject, state, now(), note);
    const transact = work => { database.exec('BEGIN IMMEDIATE'); try { const result = work(); database.exec('COMMIT'); return result; } catch (error) { database.exec('ROLLBACK'); throw error; } };
    const account = id => { const value = database.prepare('SELECT id,email,panel_id FROM accounts WHERE id=?').get(id); if (!value) throw new Error('ACCOUNT_UNAVAILABLE'); return value; };
    const balance = (id, currency) => database.prepare('SELECT coalesce(sum(units),0) AS balance FROM ledger WHERE account=? AND currency=?').get(id, currency).balance;
    const api = {
        reconciliationEnabled,
        provision(email, password, panelId) {
            if (!emailAddress(email) || typeof password !== 'string' || password.length < 12 || password.length > 128 || !Number.isSafeInteger(panelId) || panelId <= 0) throw new Error('INVALID_ACCOUNT');
            const id = randomBytes(12).toString('hex'); const salt = randomBytes(16).toString('hex');
            database.prepare('INSERT INTO accounts VALUES (?,?,?,?,?)').run(id, email.toLowerCase(), salt, scryptSync(password, salt, 32).toString('hex'), panelId);
            return { id };
        },
        login(email, password, clientAddress) {
            if (!emailAddress(email) || typeof password !== 'string' || password.length > 128) throw new Error('LOGIN_FAILED');
            const key = hash(String(clientAddress) + '\0' + email.toLowerCase());
            transact(() => {
                database.prepare('DELETE FROM attempts WHERE until<?').run(now());
                if ((database.prepare('SELECT count FROM attempts WHERE key=?').get(key)?.count ?? 0) >= 5) throw new Error('LOGIN_FAILED');
                database.prepare('INSERT INTO attempts VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key, now() + 900000);
            });
            const row = database.prepare('SELECT * FROM accounts WHERE email=?').get(email.toLowerCase());
            const result = scryptSync(password, row?.salt ?? 'dummy-salt', 32);
            if (!row || !timingSafeEqual(result, Buffer.from(row.password, 'hex'))) throw new Error('LOGIN_FAILED');
            database.prepare('DELETE FROM attempts WHERE key=?').run(key);
            database.prepare('DELETE FROM sessions WHERE expires<?').run(now());
            const token = randomBytes(32).toString('hex'); const csrf = randomBytes(24).toString('hex');
            database.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(hash(token), row.id, csrf, now() + 3600000);
            return { token, csrf, accountId: row.id };
        },
        session(token) {
            if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('SESSION_EXPIRED');
            const row = database.prepare('SELECT account,csrf FROM sessions WHERE token=? AND expires>?').get(hash(token), now());
            if (!row) throw new Error('SESSION_EXPIRED');
            return row;
        },
        logout(token) { database.prepare('DELETE FROM sessions WHERE token=?').run(hash(token)); },
        account(id) { const value = account(id); return { email: value.email, panelId: value.panel_id, balances: { RUB: balance(id, 'RUB'), USDT: balance(id, 'USDT') } }; },
        payment(id, currency, units) {
            account(id);
            if (!currencyValid(currency) || !unitsValid(units)) throw new Error('INVALID_PAYMENT');
            if (database.prepare('SELECT count(*) AS count FROM payments WHERE account=? AND state=?').get(id, 'pending').count >= 3) throw new Error('PAYMENT_PENDING');
            const paymentId = randomBytes(12).toString('hex');
            database.prepare('INSERT INTO payments VALUES (?,?,?,?,?,?)').run(paymentId, id, currency, units, 'pending', now());
            return { id: paymentId, state: 'pending', note: 'Баланс не зачислен. Администратор должен проверить поступление вручную.' };
        },
        payments(id) { account(id); return database.prepare('SELECT id,currency,units,state,created FROM payments WHERE account=? ORDER BY created DESC LIMIT 20').all(id); },
        pendingPayments() { return database.prepare('SELECT payments.id,payments.currency,payments.units,payments.created,accounts.panel_id FROM payments JOIN accounts ON accounts.id=payments.account WHERE payments.state=? ORDER BY payments.created LIMIT 20').all('pending'); },
        approvePayment(paymentId, reference) {
            if (typeof reference !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{1,19}:[A-Za-z0-9:_-]{4,100}$/.test(reference)) throw new Error('PAYMENT_REFERENCE_REQUIRED');
            return transact(() => {
                const row = database.prepare('SELECT * FROM payments WHERE id=? AND state=?').get(paymentId, 'pending');
                if (!row) throw new Error('PAYMENT_NOT_PENDING');
                if (!Number.isSafeInteger(balance(row.account, row.currency) + row.units)) throw new Error('BALANCE_LIMIT');
                database.prepare('INSERT INTO manual_receipts VALUES (?,?)').run(hash(reference.toLowerCase()), paymentId);
                database.prepare('INSERT INTO ledger VALUES (?,?,?,?,?)').run(paymentId, row.account, row.currency, row.units, now());
                database.prepare('UPDATE payments SET state=? WHERE id=?').run('approved', paymentId);
                audit('payment', paymentId, 'approved');
                return { credited: true, currency: row.currency, units: row.units };
            });
        },
        rejectPayment(paymentId) { return transact(() => { const result = database.prepare('UPDATE payments SET state=? WHERE id=? AND state=?').run('rejected', paymentId, 'pending'); if (result.changes) audit('payment', paymentId, 'rejected'); return { rejected: result.changes === 1 }; }); },
        requestRenewal(id, currency, plan) {
            account(id);
            if (!currencyValid(currency) || !plan || !unitsValid(plan.units) || !Number.isInteger(plan.days) || plan.days < 1 || plan.days > 366) throw new Error('RENEWAL_PLAN_UNAVAILABLE');
            if (balance(id, currency) < plan.units) throw new Error('INSUFFICIENT_BALANCE');
            return transact(() => {
                if (balance(id, currency) < plan.units) throw new Error('INSUFFICIENT_BALANCE');
                if (database.prepare("SELECT id FROM renewal_requests WHERE account=? AND state IN ('pending','executing','uncertain')").get(id)) throw new Error('RENEWAL_PENDING');
                const requestId = randomBytes(12).toString('hex');
                database.prepare('INSERT INTO renewal_requests VALUES (?,?,?,?,?,?,?,NULL)').run(requestId, id, 'pending', now(), currency, plan.units, plan.days);
                audit('renewal', requestId, 'pending');
                return { id: requestId, state: 'pending', note: 'Запрос передан администратору. Подписка пока не продлена, баланс не списан.' };
            });
        },
        renewals(id) { account(id); return database.prepare('SELECT id,currency,units,days,state,created FROM renewal_requests WHERE account=? ORDER BY created DESC,id DESC LIMIT 20').all(id); },
        billingHistory() { return database.prepare('SELECT operation,subject,state,created,note FROM billing_audit ORDER BY created DESC,id DESC LIMIT 20').all(); },
        recoveryCases() {
            if (!reconciliationEnabled) throw new Error('RECONCILIATION_DISABLED');
            return database.prepare("SELECT renewal.id,account.panel_id,renewal.state,clock.started FROM renewal_requests renewal JOIN accounts account ON account.id=renewal.account JOIN renewal_clock clock ON clock.id=renewal.id WHERE renewal.state IN ('executing','uncertain') ORDER BY clock.started,renewal.id LIMIT 20").all().map(row => ({ ...row, readyAt: row.started + reviewDelayMs }));
        },
        recoveryCase(id) {
            if (!reconciliationEnabled) throw new Error('RECONCILIATION_DISABLED');
            if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) throw new Error('INVALID_RECONCILIATION');
            const row = database.prepare("SELECT renewal.id,account.panel_id,renewal.state,renewal.proposal,renewal.currency,renewal.units,renewal.days,clock.started FROM renewal_requests renewal JOIN accounts account ON account.id=renewal.account JOIN renewal_clock clock ON clock.id=renewal.id WHERE renewal.id=? AND renewal.state IN ('executing','uncertain')").get(id);
            if (!row || !unitsValid(row.units) || !currencyValid(row.currency) || !Number.isSafeInteger(row.panel_id) || row.panel_id <= 0 || !Number.isSafeInteger(row.started) || row.started < 0 || !Number.isSafeInteger(row.started + reviewDelayMs) || !/^[A-Za-z0-9_-]{16}$/.test(row.proposal ?? '')) throw new Error('RECONCILIATION_UNAVAILABLE');
            return { ...row, readyAt: row.started + reviewDelayMs, observedAt: now() };
        },
        reconcileRenewal(id, { state, proposal, outcome, note } = {}) {
            if (!reconciliationEnabled) throw new Error('RECONCILIATION_DISABLED');
            if (!['executing', 'uncertain'].includes(state) || typeof proposal !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(proposal) || !['done', 'refunded'].includes(outcome) || typeof note !== 'string' || note.trim().length < 8 || note.length > 200 || /[\u0000-\u001f\u007f]/.test(note) || redactSupport(note) !== note) throw new Error('INVALID_RECONCILIATION');
            return transact(() => {
                const row = api.recoveryCase(id);
                if (row.state !== state || row.proposal !== proposal || now() < row.readyAt) throw new Error('RECONCILIATION_NOT_READY');
                if (outcome === 'refunded') {
                    const owner = database.prepare('SELECT account FROM renewal_requests WHERE id=?').get(id).account;
                    if (!Number.isSafeInteger(balance(owner, row.currency) + row.units)) throw new Error('BALANCE_LIMIT');
                    database.prepare('INSERT INTO ledger VALUES (?,?,?,?,?)').run('renewal-refund:' + id, owner, row.currency, row.units, now());
                }
                const next = outcome === 'done' ? 'done' : 'rejected';
                const updated = database.prepare('UPDATE renewal_requests SET state=? WHERE id=? AND state=? AND proposal=?').run(next, id, state, proposal);
                if (updated.changes !== 1) throw new Error('RECONCILIATION_UNAVAILABLE');
                audit('reconciliation', id, next, note.trim());
                return { settled: true, outcome };
            });
        },
        pendingRenewals() { return database.prepare('SELECT renewal.id,account.panel_id,renewal.currency,renewal.units,renewal.days FROM renewal_requests renewal JOIN accounts account ON account.id=renewal.account WHERE renewal.state=? ORDER BY renewal.created LIMIT 20').all('pending'); },
        reserveRenewal(id, proposal) {
            if (!/^[A-Za-z0-9_-]{16}$/.test(proposal)) throw new Error('INVALID_RENEWAL');
            return transact(() => {
                const row = database.prepare('SELECT * FROM renewal_requests WHERE id=? AND state=?').get(id, 'pending');
                if (!row || balance(row.account, row.currency) < row.units) throw new Error('RENEWAL_UNAVAILABLE');
                database.prepare('INSERT INTO ledger VALUES (?,?,?,?,?)').run('renewal:' + id, row.account, row.currency, -row.units, now());
                database.prepare('UPDATE renewal_requests SET state=?,proposal=? WHERE id=?').run('executing', proposal, id);
                database.prepare('INSERT INTO renewal_clock VALUES (?,?)').run(id, now());
                audit('renewal', id, 'executing');
                return { reserved: true };
            });
        },
        settleRenewal(id, outcome) {
            if (!['done', 'rejected', 'uncertain'].includes(outcome)) throw new Error('INVALID_RENEWAL');
            return transact(() => {
                const row = database.prepare('SELECT * FROM renewal_requests WHERE id=? AND state=?').get(id, 'executing');
                if (!row) throw new Error('RENEWAL_UNAVAILABLE');
                if (outcome === 'rejected') database.prepare('INSERT INTO ledger VALUES (?,?,?,?,?)').run('renewal-refund:' + id, row.account, row.currency, row.units, now());
                database.prepare('UPDATE renewal_requests SET state=? WHERE id=?').run(outcome, id);
                audit('renewal', id, outcome);
                return { settled: true, outcome };
            });
        },
        addKnowledge(id, aliases, answer) {
            if (!/^[a-z0-9_-]{1,40}$/.test(id) || !Array.isArray(aliases) || !aliases.length || aliases.length > 20 || aliases.some(value => typeof value !== 'string' || value.length > 100) || typeof answer !== 'string' || answer.length > 1200 || redactSupport(answer) !== answer) throw new Error('INVALID_KNOWLEDGE');
            const serialized = JSON.stringify(aliases.map(normalize));
            const previous = database.prepare('SELECT aliases,answer FROM knowledge WHERE id=?').get(id);
            database.prepare('INSERT OR REPLACE INTO knowledge VALUES (?,?,?)').run(id, serialized, answer);
            if (!previous || previous.aliases !== serialized || previous.answer !== answer) database.prepare('DELETE FROM private_cache').run();
        },
        knowledge(question) {
            const query = normalize(question);
            const values = database.prepare('SELECT * FROM knowledge LIMIT 100').all();
            return values.filter(value => JSON.parse(value.aliases).some(alias => query === alias)).map(value => ({ id: value.id, text: value.answer })).slice(0, 4);
        },
        snippets() { return database.prepare('SELECT id,answer AS text FROM knowledge ORDER BY id LIMIT 4').all().map(item => ({ ...item, text: item.text.slice(0, 500) })); },
        cached(id, question) { account(id); return database.prepare('SELECT answer FROM private_cache WHERE account=? AND question=? AND expires>?').get(id, hash(normalize(question)), now())?.answer; },
        cache(id, question, answer) {
            account(id);
            if (normalize(question).split(' ').length < 4 || /(?:^|\s)(?:это|эта|этот|там|тут|да|нет|он|она|они)(?:\s|$)/.test(normalize(question))) return;
            database.prepare('DELETE FROM private_cache WHERE expires<?').run(now());
            database.prepare('INSERT OR REPLACE INTO private_cache VALUES (?,?,?,?)').run(id, hash(normalize(question)), redactSupport(answer), now() + 86400000);
            database.prepare('DELETE FROM private_cache WHERE account=? AND question NOT IN (SELECT question FROM private_cache WHERE account=? ORDER BY expires DESC LIMIT 50)').run(id, id);
        },
        append(id, role, text) {
            account(id);
            if (!['user', 'assistant'].includes(role) || typeof text !== 'string' || !text.trim() || text.length > 1200) throw new Error('INVALID_MESSAGE');
            database.prepare('DELETE FROM messages WHERE created<?').run(now() - 30 * 86400000);
            database.prepare('INSERT INTO messages (account,role,text,created) VALUES (?,?,?,?)').run(id, role, redactSupport(text), now());
            database.prepare('DELETE FROM messages WHERE account=? AND id NOT IN (SELECT id FROM messages WHERE account=? ORDER BY id DESC LIMIT 100)').run(id, id);
        },
        history(id) { account(id); return database.prepare('SELECT role,text FROM messages WHERE account=? AND created>? ORDER BY id DESC LIMIT 6').all(id, now() - 30 * 86400000).reverse().map(value => ({ role: value.role, text: value.text.slice(0, 300) })); },
        handoff(id) {
            account(id);
            const existing = database.prepare('SELECT id FROM handoffs WHERE account=? AND state=?').get(id, 'pending');
            if (existing) return existing.id;
            const key = randomBytes(12).toString('hex'); database.prepare('INSERT INTO handoffs VALUES (?,?,?,?)').run(key, id, 'pending', now()); return key;
        },
        pendingSupport() { return database.prepare('SELECT handoff.id,account.panel_id FROM handoffs handoff JOIN accounts account ON account.id=handoff.account WHERE handoff.state=? ORDER BY handoff.created LIMIT 20').all('pending'); },
        supportThread(id) {
            const row = database.prepare('SELECT account FROM handoffs WHERE id=? AND state=?').get(id, 'pending');
            if (!row) throw new Error('SUPPORT_TICKET_UNAVAILABLE');
            return { id, history: api.history(row.account), media: database.prepare('SELECT id,text FROM media_reviews WHERE account=? AND state=? ORDER BY created LIMIT 5').all(row.account, 'pending') };
        },
        replySupport(id, text) {
            if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw new Error('INVALID_MESSAGE');
            return transact(() => {
                const row = database.prepare('SELECT account FROM handoffs WHERE id=? AND state=?').get(id, 'pending');
                if (!row) throw new Error('SUPPORT_TICKET_UNAVAILABLE');
                api.append(row.account, 'assistant', text);
                database.prepare('UPDATE handoffs SET state=? WHERE id=?').run('resolved', id);
                return { recorded: true };
            });
        },
        allowMedia(id) {
            account(id);
            if (!database.prepare('SELECT id FROM handoffs WHERE account=? AND state=?').get(id, 'pending')) throw new Error('MEDIA_CONTEXT_REQUIRED');
            const key = 'media:' + hash(id);
            const previous = database.prepare('SELECT until FROM attempts WHERE key=?').get(key)?.until;
            if (previous && previous > now()) throw new Error('MEDIA_RATE_LIMIT');
            const question = api.history(id).filter(item => item.role === 'user').at(-1)?.text;
            if (!question) throw new Error('MEDIA_CONTEXT_REQUIRED');
            database.prepare('INSERT OR REPLACE INTO attempts VALUES (?,1,?)').run(key, now() + 60000);
            database.prepare('INSERT OR REPLACE INTO media_permissions VALUES (?,?,?)').run(id, question, now() + 300000);
            return { allowed: true };
        },
        consumeMedia(id) {
            account(id);
            return transact(() => {
                const permission = database.prepare('SELECT question FROM media_permissions WHERE account=? AND expires>?').get(id, now());
                if (!permission) throw new Error('MEDIA_CONTEXT_REQUIRED');
                database.prepare('DELETE FROM media_permissions WHERE account=?').run(id);
                return permission;
            });
        },
        queueMedia(id, text) {
            account(id);
            const key = randomBytes(12).toString('hex');
            database.prepare('DELETE FROM media_reviews WHERE created<?').run(now() - 30 * 86400000);
            if (database.prepare('SELECT count(*) AS count FROM media_reviews WHERE account=? AND state=?').get(id, 'pending').count >= 5) throw new Error('MEDIA_RATE_LIMIT');
            database.prepare('INSERT INTO media_reviews VALUES (?,?,?,?,?)').run(key, id, redactSupport(text), 'pending', now());
            api.handoff(id); return { id: key };
        },
        mediaReview(id) { const value = database.prepare('SELECT id,text FROM media_reviews WHERE id=? AND state=?').get(id, 'pending'); if (!value) throw new Error('MEDIA_UNAVAILABLE'); return value; },
        approveMedia(id) {
            return transact(() => {
                const row = database.prepare('SELECT * FROM media_reviews WHERE id=? AND state=?').get(id, 'pending');
                if (!row) throw new Error('MEDIA_UNAVAILABLE');
                database.prepare('UPDATE media_reviews SET state=? WHERE id=?').run('approved', id);
                api.append(row.account, 'user', 'Проверенный администратором текст вложения: ' + row.text.slice(0, 400));
                return { account: row.account };
            });
        },
        eraseHistory(id) { account(id); database.prepare('DELETE FROM messages WHERE account=?').run(id); database.prepare('DELETE FROM private_cache WHERE account=?').run(id); database.prepare('DELETE FROM media_permissions WHERE account=?').run(id); database.prepare('DELETE FROM media_reviews WHERE account=?').run(id); },
        searchCache(key) { const value = database.prepare('SELECT result FROM search_cache WHERE key=? AND expires>?').get(key, now()); return value ? JSON.parse(value.result) : null; },
        putSearchCache(key, results) { database.prepare('INSERT OR REPLACE INTO search_cache VALUES (?,?,?)').run(key, JSON.stringify(results), now() + 86400000); },
        reserveSearch(limit) {
            return transact(() => {
                const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now()));
                const row = database.prepare('SELECT * FROM search_quota WHERE day=?').get(day);
                if (!Number.isInteger(limit) || limit < 1 || limit > 10 || (row?.used ?? 0) >= limit || (row && now() - row.last < 60000)) throw new Error('SEARCH_LIMIT');
                database.prepare('INSERT INTO search_quota VALUES (?,1,?) ON CONFLICT(day) DO UPDATE SET used=used+1,last=excluded.last').run(day, now());
            });
        },
        close: () => database.close(),
    };
    return api;
}

export function createSupport({ store, answer, search, now = Date.now }) {
    let busy = false; const rate = new Map();
    return async (accountId, question) => {
        if (typeof question !== 'string' || !question.trim() || question.length > 500) throw new Error('INVALID_MESSAGE');
        const sanitized = redactSupport(question);
        const known = store.knowledge(sanitized);
        const cached = store.cached(accountId, sanitized);
        if (known.length || cached) {
            const reply = known[0]?.text ?? cached;
            store.append(accountId, 'user', sanitized); store.append(accountId, 'assistant', reply);
            return { reply, source: known.length ? 'knowledge' : 'private_cache', needsHuman: false };
        }
        if (busy || now() - (rate.get(accountId) ?? -Infinity) < 60000) throw new Error('SUPPORT_RATE_LIMIT');
        while (rate.size > 1000) rate.delete(rate.keys().next().value);
        rate.set(accountId, now());
        const history = store.history(accountId);
        store.append(accountId, 'user', sanitized);
        busy = true;
        try {
            if (search && /^(?:найди|найти)\s+инструкци[юи]\s/i.test(sanitized)) {
                const results = await search(sanitized);
                const reply = 'Найдены инструкции из разрешённых источников. Проверьте, что они подходят вашей версии приложения. Содержимое сайтов не выполняется как команды.';
                store.append(accountId, 'assistant', reply);
                return { reply, source: 'web', sources: results.map(item => ({ title: item.title, url: item.url })), needsHuman: false };
            }
            if (!answer) throw new Error('SUPPORT_AI_DISABLED');
            const input = { question: sanitized, knowledge: [...store.snippets()], history: [...history] };
            while (Buffer.byteLength(JSON.stringify(input), 'utf8') > 4096 && input.knowledge.length) input.knowledge.pop();
            while (Buffer.byteLength(JSON.stringify(input), 'utf8') > 4096 && input.history.length) input.history.shift();
            const result = await answer(input);
            if (!result || typeof result.reply !== 'string' || result.reply.length > 1200 || typeof result.needsHuman !== 'boolean') throw new Error('SUPPORT_UNAVAILABLE');
            const reply = redactSupport(result.reply);
            store.append(accountId, 'assistant', reply);
            if (result.needsHuman) store.handoff(accountId);
            else if (!history.length) store.cache(accountId, sanitized, reply);
            return { ...result, reply, source: 'ai' };
        } catch {
            store.handoff(accountId);
            const reply = 'Передано администратору. Укажите приложение, систему и текст ошибки, но не присылайте пароль, токен или ссылку подписки.';
            store.append(accountId, 'assistant', reply);
            return { reply, source: 'human', needsHuman: true };
        } finally { busy = false; }
    };
}
