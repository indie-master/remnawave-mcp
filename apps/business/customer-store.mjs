import { randomBytes, createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const telegramId = value => Number.isSafeInteger(value) && value > 0;
const token = () => randomBytes(24).toString('base64url');

export function createCustomerStore({ database, transact, api, enabled = false, now = Date.now }) {
    if (typeof enabled !== 'boolean') throw new Error('INVALID_CUSTOMER_CONFIGURATION');
    database.exec(`
        CREATE TABLE IF NOT EXISTS telegram_users (telegram_id INTEGER PRIMARY KEY,account TEXT NOT NULL UNIQUE,nonce TEXT NOT NULL,created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS telegram_codes (digest TEXT PRIMARY KEY,account TEXT NOT NULL UNIQUE,expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS telegram_incoming (key TEXT PRIMARY KEY,telegram_id INTEGER NOT NULL,digest TEXT NOT NULL,result TEXT NOT NULL,created INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS telegram_outbox (id TEXT PRIMARY KEY,account TEXT NOT NULL,telegram_id INTEGER NOT NULL,nonce TEXT NOT NULL,message_key TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,lease TEXT,UNIQUE(message_key,nonce));
    `);
    const guard = () => { if (!enabled) throw new Error('CUSTOMER_DISABLED'); };
    const binding = id => { guard(); if (!telegramId(id)) throw new Error('CUSTOMER_NOT_LINKED'); const value = database.prepare('SELECT * FROM telegram_users WHERE telegram_id=?').get(id); if (!value) throw new Error('CUSTOMER_NOT_LINKED'); return value; };
    const limit = (subject, maximum, window = 60000) => {
        const key = 'customer:' + subject;
        const previous = database.prepare('SELECT count,until FROM attempts WHERE key=?').get(key);
        if (previous && previous.until > now() && previous.until <= now() + window) {
            if (previous.count >= maximum) throw new Error('CUSTOMER_RATE_LIMIT');
            database.prepare('UPDATE attempts SET count=count+1 WHERE key=?').run(key);
        } else database.prepare('INSERT OR REPLACE INTO attempts VALUES (?,1,?)').run(key, now() + window);
    };
    return {
        enabled,
        state(account) { api.account(account); return { enabled, linked: !!database.prepare('SELECT 1 FROM telegram_users WHERE account=?').get(account) }; },
        issue(account) {
            guard(); api.account(account);
            return transact(() => {
                if (database.prepare('SELECT 1 FROM telegram_users WHERE account=?').get(account)) throw new Error('CUSTOMER_ALREADY_LINKED');
                limit('link:' + account, 3);
                database.prepare('DELETE FROM telegram_codes WHERE expires<=? OR account=?').run(now(), account);
                const value = token(); const expiresAt = now() + 300000;
                database.prepare('INSERT INTO telegram_codes VALUES (?,?,?)').run(hash(value), account, expiresAt);
                return { code: value, expiresAt };
            });
        },
        link(id, code) {
            guard(); if (!telegramId(id) || typeof code !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(code)) throw new Error('CUSTOMER_LINK_REJECTED');
            transact(() => limit('attempt:' + id, 5));
            return transact(() => {
                const row = database.prepare('SELECT account FROM telegram_codes WHERE digest=? AND expires>? AND expires<=?').get(hash(code), now(), now() + 300000);
                if (!row || database.prepare('SELECT 1 FROM telegram_users WHERE telegram_id=? OR account=?').get(id, row.account)) throw new Error('CUSTOMER_LINK_REJECTED');
                database.prepare('INSERT INTO telegram_users VALUES (?,?,?,?)').run(id, row.account, token(), now());
                database.prepare('DELETE FROM telegram_codes WHERE digest=?').run(hash(code));
                return { linked: true };
            });
        },
        unlink(account) {
            api.account(account);
            return transact(() => {
                database.prepare('DELETE FROM telegram_users WHERE account=?').run(account);
                database.prepare('DELETE FROM telegram_codes WHERE account=?').run(account);
                database.prepare("UPDATE telegram_outbox SET state='cancelled' WHERE account=? AND state='pending'").run(account);
                return { unlinked: true };
            });
        },
        account(id) { return api.account(binding(id).account); },
        history(id) { return api.supportHistory(binding(id).account); },
        question(id, key, text) {
            guard();
            if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(key) || typeof text !== 'string' || !text.trim() || text.length > 500) throw new Error('INVALID_MESSAGE');
            return transact(() => {
                const row = binding(id); const digest = hash(row.nonce + '\0' + text);
                const previous = database.prepare('SELECT telegram_id,digest,result FROM telegram_incoming WHERE key=?').get(key);
                if (previous) { if (previous.telegram_id !== id || previous.digest !== digest) throw new Error('CUSTOMER_MESSAGE_REJECTED'); return { ...JSON.parse(previous.result), replayed: true }; }
                limit('chat:' + id, 10);
                const open = api.openSupport(row.account); const knowledge = open ? [] : api.knowledge(text);
                api.append(row.account, 'user', text);
                let result;
                if (knowledge.length) { api.append(row.account, 'assistant', knowledge[0].text); result = { reply: knowledge[0].text, source: 'knowledge' }; }
                else {
                    api.handoff(row.account);
                    const reply = open ? '' : 'Обращение передано администратору. Ответ появится в этом чате и кабинете.';
                    if (reply) api.append(row.account, 'assistant', reply);
                    result = { reply, source: 'human' };
                }
                database.prepare('INSERT INTO telegram_incoming VALUES (?,?,?,?,?)').run(key, id, digest, JSON.stringify(result), now());
                database.prepare('DELETE FROM telegram_incoming WHERE created<?').run(now() - 30 * 86400000);
                database.prepare('DELETE FROM telegram_incoming WHERE telegram_id=? AND key NOT IN (SELECT key FROM telegram_incoming WHERE telegram_id=? ORDER BY created DESC,rowid DESC LIMIT 100)').run(id, id);
                return result;
            });
        },
        enqueue(account, message, messageKey) {
            if (!enabled) return;
            const row = database.prepare('SELECT telegram_id,nonce FROM telegram_users WHERE account=?').get(account);
            if (row) database.prepare("INSERT OR IGNORE INTO telegram_outbox VALUES (?,?,?,?,?,?,'pending',?,NULL)").run(randomBytes(12).toString('hex'), account, row.telegram_id, row.nonce, messageKey, message.text, now());
        },
        claim() {
            guard();
            return transact(() => {
                database.prepare("UPDATE telegram_outbox SET state='uncertain' WHERE state='sending'").run();
                database.prepare("DELETE FROM telegram_outbox WHERE state IN ('done','expired','cancelled') AND created<?").run(now() - 30 * 86400000);
                database.prepare("UPDATE telegram_outbox SET text='[срок хранения истёк]' WHERE state='uncertain' AND created<?").run(now() - 30 * 86400000);
                database.prepare("UPDATE telegram_outbox SET state='expired' WHERE state='pending' AND created<?").run(now() - 86400000);
                database.prepare("UPDATE telegram_outbox SET state='cancelled' WHERE state='pending' AND NOT EXISTS(SELECT 1 FROM telegram_users WHERE telegram_users.account=telegram_outbox.account AND telegram_users.telegram_id=telegram_outbox.telegram_id AND telegram_users.nonce=telegram_outbox.nonce)").run();
                const item = database.prepare("SELECT id,telegram_id,text FROM telegram_outbox WHERE state='pending' ORDER BY created,id LIMIT 1").get();
                if (!item) return { delivery: null };
                const lease = token();
                database.prepare("UPDATE telegram_outbox SET state='sending',lease=? WHERE id=? AND state='pending'").run(lease, item.id);
                return { delivery: { id: item.id, telegramId: item.telegram_id, text: item.text, lease } };
            });
        },
        settle(id, lease, outcome) {
            guard();
            if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id) || typeof lease !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(lease) || !['done', 'uncertain'].includes(outcome)) throw new Error('CUSTOMER_DELIVERY_REJECTED');
            return transact(() => {
                const result = database.prepare("UPDATE telegram_outbox SET state=? WHERE id=? AND lease=? AND state='sending'").run(outcome, id, lease);
                if (!result.changes) { const previous = database.prepare('SELECT state,lease FROM telegram_outbox WHERE id=?').get(id); if (previous?.state !== outcome || previous.lease !== lease) throw new Error('CUSTOMER_DELIVERY_REJECTED'); }
                return { settled: true };
            });
        },
    };
}
