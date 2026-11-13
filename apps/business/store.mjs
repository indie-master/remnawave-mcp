import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { createCustomerStore } from './customer-store.mjs';
import { createIdentityStore } from './identity.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const emailAddress = value => typeof value === 'string' && value.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value);
const currencyValid = value => ['RUB', 'USDT'].includes(value);
const unitsValid = value => Number.isSafeInteger(value) && value > 0 && value <= 100000000000;
export const redactSupport = value => String(value).replace(/https?:\/\/\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\b\d{5,20}:[A-Za-z0-9_-]{30,}\b|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\b(?:\d{1,3}\.){3}\d{1,3}\b/gi, '[скрыто]').slice(0, 500);
const normalize = value => redactSupport(value).normalize('NFKC').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

export function createBusinessStore({ filename, now = Date.now, reconciliationEnabled = false, reviewDelayMs = 900000, customerEnabled = false, customerSignupEnabled = true }) {
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
        CREATE TABLE IF NOT EXISTS support_receipts (key TEXT PRIMARY KEY, ticket TEXT NOT NULL, body_hash TEXT NOT NULL, created INTEGER NOT NULL);
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
    const identity = createIdentityStore({ database, now });
    const issueSession = (id, telegram) => {
        account(id); database.prepare('DELETE FROM sessions WHERE expires<?').run(now()); identity.cleanSessions();
        const token = randomBytes(32).toString('hex'); const csrf = randomBytes(24).toString('hex');
        database.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(hash(token), id, csrf, now() + 3600000);
        if (telegram) database.prepare('INSERT INTO telegram_sessions VALUES (?,?,?)').run(hash(token), telegram.telegram_id, telegram.nonce);
        return { token, csrf, accountId: id };
    };
    let customer;
    const api = {
        reconciliationEnabled,
        provision(email, password, panelId) {
            if (!emailAddress(email) || email.toLowerCase().endsWith('@accounts.invalid') || typeof password !== 'string' || password.length < 12 || password.length > 128 || !Number.isSafeInteger(panelId) || panelId <= 0) throw new Error('INVALID_ACCOUNT');
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
            const row            return { allowed: true };
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
    customer = createCustomerStore({ database, transact, api, enabled: customerEnabled, signupEnabled: customerSignupEnabled, now });
    return Object.assign(api, { customer });
}

export function createSupport({ store, answer, search, now = Date.now }) {
    let busy = false; const rate = new Map(); const chatRate = new Map();
    return async (accountId, question) => {
        if (typeof question !== 'string' || !question.trim() || question.length > 500) throw new Error('INVALID_MESSAGE');
        const sanitized = redactSupport(question);
        if (store.openSupport(accountId)) {
            while (chatRate.size > 1000) chatRate.delete(chatRate.keys().next().value);
            let window = chatRate.get(accountId);
            if (!window || now() < window.at || now() - window.at >= 60000) { window = { at: now(), count: 0 }; chatRate.set(accountId, window); }
            if (window.count >= 10) throw new Error('SUPPORT_RATE_LIMIT');
            window.count++;
            store.append(accountId, 'user', sanitized);
            return { reply: 'Сообщение добавлено в вашу переписку с поддержкой.', source: 'human', needsHuman: true };
        }
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
            const reply = 'Обращение передано администратору. Ответ появится здесь.';
            store.append(accountId, 'assistant', reply);
            return { reply, source: 'human', needsHuman: true };
        } finally { busy = false; }
    };
}
