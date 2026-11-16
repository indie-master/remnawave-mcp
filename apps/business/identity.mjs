import { randomBytes, scryptSync } from 'node:crypto';

const emailValid = value => typeof value === 'string' && value.length <= 254 && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value) && !value.toLowerCase().endsWith('@accounts.invalid');
export function createIdentityStore({ database, now }) {
    database.exec(`CREATE TABLE IF NOT EXISTS account_identity (account TEXT PRIMARY KEY,email_enabled INTEGER NOT NULL,name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS telegram_sessions (token TEXT PRIMARY KEY,telegram_id INTEGER NOT NULL,nonce TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS telegram_launches (digest TEXT PRIMARY KEY,expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS telegram_bot_identity (username TEXT PRIMARY KEY,bot_id INTEGER NOT NULL);`);
    const state = id => database.prepare('SELECT email_enabled,name FROM account_identity WHERE account=?').get(id);
    return {
        state,
        hasEmail(id) { return state(id)?.email_enabled !== 0; },
        createTelegram(profile) {
            const id = randomBytes(12).toString('hex'); const salt = randomBytes(16).toString('hex');
            const name = [profile.firstName, profile.lastName].filter(value => typeof value === 'string').join(' ').replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 96).trim() || 'Пользователь Telegram';
            database.prepare('INSERT INTO accounts VALUES (?,?,?,?,0)').run(id, `telegram+${id}@accounts.invalid`, salt, scryptSync(randomBytes(32), salt, 32).toString('hex'));
            database.prepare('INSERT INTO account_identity VALUES (?,0,?)').run(id, name);
            return id;
        },
        setEmail(id, email, password) {
            if (!state(id) || state(id).email_enabled !== 0 || !emailValid(email) || typeof password !== 'string' || password.length < 12 || password.length > 128) throw new Error('EMAIL_LINK_REJECTED');
            if (database.prepare('SELECT 1 FROM accounts WHERE email=?').get(email.toLowerCase())) throw new Error('EMAIL_IN_USE');
            const salt = randomBytes(16).toString('hex');
            database.prepare('UPDATE accounts SET email=?,salt=?,password=? WHERE id=?').run(email.toLowerCase(), salt, scryptSync(password, salt, 32).toString('hex'), id);
            database.prepare('UPDATE account_identity SET email_enabled=1 WHERE account=?').run(id);
            database.prepare('DELETE FROM sessions WHERE account=?').run(id);
        },
        mergeInto(source, target) {
            if (source === target) return;
            const row = database.prepare('SELECT panel_id FROM accounts WHERE id=?').get(source);
            if (state(source)?.email_enabled !== 0 || row?.panel_id !== 0 || !database.prepare('SELECT 1 FROM accounts WHERE id=?').get(target)) throw new Error('ACCOUNT_MERGE_REQUIRES_ADMIN');
            for (const table of ['payments', 'ledger', 'renewal_requests', 'media_reviews']) if (database.prepare(`SELECT 1 FROM ${table} WHERE account=?`).get(source)) throw new Error('ACCOUNT_MERGE_REQUIRES_ADMIN');
            for (const table of ['messages', 'handoffs']) database.prepare(`UPDATE ${table} SET account=? WHERE account=?`).run(target, source);
            // Preserve the transcript and receipts, with one open conversation after joining two proven identities.
            database.prepare("UPDATE handoffs SET state='resolved' WHERE account=? AND state='pending' AND id NOT IN (SELECT id FROM handoffs WHERE account=? AND state='pending' ORDER BY created DESC,id DESC LIMIT 1)").run(target, target);
            for (const table of ['private_cache', 'media_permissions', 'account_identity']) database.prepare(`DELETE FROM ${table} WHERE account=?`).run(source);
            database.prepare('DELETE FROM sessions WHERE account=? OR account=?').run(source, target);
            database.prepare('DELETE FROM accounts WHERE id=?').run(source);
        },
        cleanSessions() { database.prepare('DELETE FROM telegram_sessions WHERE token NOT IN (SELECT token FROM sessions)').run(); },
        validTelegramSession(token) {
            const row = database.prepare('SELECT telegram_id,nonce FROM telegram_sessions WHERE token=?').get(token);
            return !row || !!database.prepare('SELECT 1 FROM telegram_users WHERE telegram_id=? AND nonce=?').get(row.telegram_id, row.nonce);
        },
    };
}
