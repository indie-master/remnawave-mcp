import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { validateIntent } from './intent.mjs';

export function normalizeQuestion(text) {
    if (typeof text !== 'string' || text.length < 1 || text.length > 500 || /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\b\d{5,20}:[A-Za-z0-9_-]{30,}\b|https?:\/\//i.test(text)) throw new Error('AI_TEXT_REJECTED');
    const normalized = text.normalize('NFKC').toLowerCase().replace(/ё/g, 'е').trim().replace(/\s+/g, ' ').replace(/[?!.]+$/, '').trim();
    if (!normalized) throw new Error('AI_TEXT_REJECTED');
    return normalized;
}

function moscowDay(timestamp) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp));
}

export function createIntentStore({ filename, dailyLimit = 10, minIntervalMs = 60000, ttlMs = 7 * 86400000, maxEntries = 256, now = Date.now }) {
    if (!Number.isInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > 10 || !Number.isSafeInteger(minIntervalMs) || minIntervalMs < 60000 || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 1000)
        throw new Error('INVALID_AI_CONFIGURATION');
    let database;
    try {
        database = new DatabaseSync(filename);
        database.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;');
        if (database.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('AI_STATE_UNAVAILABLE');
        database.exec(`
            CREATE TABLE IF NOT EXISTS intent_cache (key TEXT PRIMARY KEY, action TEXT NOT NULL, days INTEGER NOT NULL, expires INTEGER NOT NULL, updated INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS ai_quota (day TEXT PRIMARY KEY, attempts INTEGER NOT NULL CHECK(attempts >= 0));
            CREATE TABLE IF NOT EXISTS ai_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        `);
    } catch {
        database?.close();
        throw new Error('AI_STATE_UNAVAILABLE');
    }
    const keyFor = text => createHash('sha256').update('intent-v1\0' + normalizeQuestion(text)).digest('hex');
    const safe = operation => {
        try { return operation(); }
        catch (error) {
            if (['AI_DAILY_LIMIT', 'AI_RATE_LIMIT', 'AI_CLOCK_UNAVAILABLE', 'AI_TEXT_REJECTED'].includes(error?.message)) throw error;
            throw new Error('AI_STATE_UNAVAILABLE');
        }
    };
    return {
        get: text => safe(() => {
            const row = database.prepare('SELECT action, days, expires FROM intent_cache WHERE key=?').get(keyFor(text));
            if (!row || row.expires <= now()) return null;
            return validateIntent({ action: row.action, days: row.days });
        }),
        put: (text, value) => safe(() => {
            const intent = validateIntent(value);
            if (intent.action === 'help') return;
            const timestamp = now();
            database.exec('BEGIN IMMEDIATE');
            try {
                database.prepare('DELETE FROM intent_cache WHERE expires<=?').run(timestamp);
                database.prepare('INSERT OR REPLACE INTO intent_cache (key,action,days,expires,updated) VALUES (?,?,?,?,?)').run(keyFor(text), intent.action, intent.days, timestamp + ttlMs, timestamp);
                database.prepare('DELETE FROM intent_cache WHERE key IN (SELECT key FROM intent_cache ORDER BY updated DESC, key DESC LIMIT -1 OFFSET ?)').run(maxEntries);
                database.exec('COMMIT');
            } catch (error) { database.exec('ROLLBACK'); throw error; }
        }),
        reserve: () => safe(() => {
            const timestamp = now();
            const day = moscowDay(timestamp);
            database.exec('BEGIN IMMEDIATE');
            try {
                const last = database.prepare("SELECT value FROM ai_meta WHERE key='last_attempt'").get()?.value;
                const attempts = database.prepare('SELECT attempts FROM ai_quota WHERE day=?').get(day)?.attempts ?? 0;
                if (!Number.isSafeInteger(attempts) || attempts < 0 || attempts > 10 || (last !== undefined && !Number.isSafeInteger(last))) throw new Error('AI_STATE_UNAVAILABLE');
                if (last !== undefined && timestamp < last) throw new Error('AI_CLOCK_UNAVAILABLE');
                if (attempts >= dailyLimit) throw new Error('AI_DAILY_LIMIT');
                if (last !== undefined && timestamp - last < minIntervalMs) throw new Error('AI_RATE_LIMIT');
                database.prepare('INSERT INTO ai_quota (day,attempts) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET attempts=attempts+1').run(day);
                database.prepare("INSERT OR REPLACE INTO ai_meta (key,value) VALUES ('last_attempt',?)").run(timestamp);
                database.exec('COMMIT');
                return { day, used: attempts + 1, limit: dailyLimit, remaining: dailyLimit - attempts - 1 };
            } catch (error) { database.exec('ROLLBACK'); throw error; }
        }),
        status: () => safe(() => {
            const timestamp = now();
            const last = database.prepare("SELECT value FROM ai_meta WHERE key='last_attempt'").get()?.value;
            if (last !== undefined && timestamp < last) throw new Error('AI_CLOCK_UNAVAILABLE');
            const day = moscowDay(timestamp);
            const used = database.prepare('SELECT attempts FROM ai_quota WHERE day=?').get(day)?.attempts ?? 0;
            const cacheEntries = database.prepare('SELECT COUNT(*) AS count FROM intent_cache WHERE expires>?').get(now()).count;
            if (!Number.isSafeInteger(used) || used < 0 || !Number.isSafeInteger(cacheEntries)) throw new Error('AI_STATE_UNAVAILABLE');
            return { day, used, limit: dailyLimit, remaining: Math.max(0, dailyLimit - used), cacheEntries };
        }),
        close: () => database.close(),
    };
}
