import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createIntentStore, maxDailyAiAttempts, normalizeQuestion } from './intent-store.mjs';
import { createBudgetedIntent, localIntent } from './budgeted-intent.mjs';
import { createRunSafety, waitForOperator } from './run-safety.mjs';
import { createDashboard } from './dashboard.mjs';
import { connectReportMcp } from './report-mcp.mjs';

const start = Date.UTC(2026, 9, 15, 12);
const newFile = name => join(mkdtempSync(join(tmpdir(), 'panel-bot-test-')), name);
const question = index => `Проверить сводку номер ${index}`;

test('cache normalizes only harmless variations and keeps different periods distinct', () => {
    assert.equal(normalizeQuestion('  СТАТИСТИКА   ПАНЕЛИ?! '), 'статистика панели');
    assert.notEqual(normalizeQuestion('подписки 3 дня'), normalizeQuestion('подписки 7 дней'));
    for (const text of ['', ' '.repeat(20), 'a'.repeat(501), 'https://example.invalid/secret', '123456789:' + 'A'.repeat(35)]) assert.throws(() => normalizeQuestion(text), /AI_TEXT_REJECTED/);
});

test('learned intents and daily reservations survive database close and reopen', async () => {
    const filename = newFile('intent.sqlite');
    let calls = 0;
    let store = createIntentStore({ filename, now: () => start });
    const classify = createBudgetedIntent({ store, classify: async () => { calls++; return { action: 'stats', days: 3 }; } });
    await classify('Сводка по интеграции?');
    assert.equal(store.status().used, 1);
    store.close();
    store = createIntentStore({ filename, now: () => start + 1 });
    try {
        const afterRestart = createBudgetedIntent({ store, classify: async () => { calls++; } });
        assert.deepEqual(await afterRestart('  СВОДКА  ПО ИНТЕГРАЦИИ! '), { action: 'stats', days: 3 });
        assert.equal(calls, 1);
        assert.equal(store.status().used, 1);
    } finally { store.close(); }
});

test('the hundred-and-first new AI request is refused while cached and local commands remain available', async () => {
    let clock = start;
    let calls = 0;
    const store = createIntentStore({ filename: ':memory:', now: () => clock });
    try {
        const classify = createBudgetedIntent({ store, classify: async () => { calls++; return { action: 'stats', days: 3 }; } });
        assert.equal(store.status().limit, 100);
        for (let index = 0; index < 100; index++) { await classify(question(index)); clock += 60000; }
        await assert.rejects(classify(question(100)), /AI_DAILY_LIMIT/);
        assert.equal(store.status().used, 100);
        assert.equal(store.status().remaining, 0);
        await classify(question(0));
        await classify('проверь ноды');
        assert.equal(calls, 100);
    } finally { store.close(); }
});

test('raising the legacy limit keeps spent attempts and cached intents across restarts above ten uses', async () => {
    const filename = newFile('legacy-intent.sqlite');
    let clock = start;
    let store = createIntentStore({ filename, dailyLimit: 10, now: () => clock });
    for (let index = 0; index < 6; index++) { store.reserve(); clock += 60000; }
    store.put('Legacy cached question', { action: 'stats', days: 3 });
    store.close();
    store = createIntentStore({ filename, now: () => clock });
    try {
        assert.deepEqual({ used: store.status().used, limit: store.status().limit, remaining: store.status().remaining }, { used: 6, limit: 100, remaining: 94 });
        let calls = 0;
        const classify = createBudgetedIntent({ store, classify: async () => { calls++; return { action: 'stats', days: 3 }; } });
        await classify('LEGACY CACHED QUESTION?');
        assert.equal(calls, 0);
        assert.equal(store.status().used, 6);
        for (let index = 6; index < 11; index++) { store.reserve(); clock += 60000; }
        store.close();
        store = createIntentStore({ filename, now: () => clock });
        assert.equal(store.status().used, 11);
        assert.equal(store.status().remaining, 89);
        assert.equal(store.reserve().used, 12);
    } finally { store.close(); }
});

test('only finite integer daily caps from zero through one hundred are accepted', () => {
    assert.equal(maxDailyAiAttempts, 100);
    for (const dailyLimit of [-1, 101, Infinity, NaN, 1.5, '100', null]) assert.throws(() => createIntentStore({ filename: ':memory:', dailyLimit }), /INVALID_AI_CONFIGURATION/);
    const store = createIntentStore({ filename: ':memory:', dailyLimit: 0, now: () => start });
    try { assert.throws(() => store.reserve(), /AI_DAILY_LIMIT/); }
    finally { store.close(); }
});

test('lowering a configured cap does not erase already spent attempts or invalidate their history', () => {
    const filename = newFile('lower-cap.sqlite');
    let clock = start;
    const previous = createIntentStore({ filename, now: () => clock });
    for (let index = 0; index < 11; index++) { previous.reserve(); clock += 60000; }
    previous.close();
    const store = createIntentStore({ filename, dailyLimit: 10, now: () => clock });
    try {
        assert.equal(store.status().used, 11);
        assert.equal(store.status().remaining, 0);
        assert.throws(() => store.reserve(), /AI_DAILY_LIMIT/);
    } finally { store.close(); }
});

test('the owner budget command displays the new cap without charging another attempt', async () => {
    let clock = start;
    const store = createIntentStore({ filename: ':memory:', now: () => clock });
    try {
        for (let index = 0; index < 6; index++) { store.reserve(); clock += 60000; }
        const handle = createDashboard({ allowedUserId: 123456789, now: () => clock, budgetStatus: store.status });
        const reply = await handle({ update_id: 1, message: { text: '/budget', date: Math.floor(clock / 1000), chat: { type: 'private', id: 123456789 }, from: { id: 123456789, is_bot: false } } });
        assert.match(reply.text, /Попыток: 6\/100/);
        assert.match(reply.text, /Осталось: 94/);
        assert.equal(store.status().used, 6);
    } finally { store.close(); }
});

test('failed attempts are charged before the external classifier and never retried automatically', async () => {
    let clock = start;
    let calls = 0;
    const store = createIntentStore({ filename: ':memory:', now: () => clock });
    try {
        const classify = createBudgetedIntent({ store, classify: async () => { calls++; throw new Error('FAKE_PRIVATE_ERROR'); } });
        await assert.rejects(classify(question(1)));
        await assert.rejects(classify(question(2)), /AI_RATE_LIMIT/);
        assert.equal(store.status().used, 1);
        assert.equal(calls, 1);
        clock += 60000;
        await assert.rejects(classify(question(2)));
        assert.equal(store.status().used, 2);
        assert.equal(calls, 2);
    } finally { store.close(); }
});

test('quota follows Moscow midnight and refuses a backwards clock', () => {
    let clock = Date.UTC(2026, 9, 15, 20, 58);
    const store = createIntentStore({ filename: ':memory:', now: () => clock });
    try {
        assert.equal(store.reserve().day, '2026-10-15');
        clock = Date.UTC(2026, 9, 15, 21, 0);
        assert.equal(store.status().used, 0);
        assert.equal(store.reserve().day, '2026-10-16');
        clock -= 86400000;
        assert.throws(() => store.reserve(), /AI_CLOCK_UNAVAILABLE/);
        assert.throws(() => store.status(), /AI_CLOCK_UNAVAILABLE/);
    } finally { store.close(); }
});

test('two database connections share the same atomic daily cap', () => {
    const filename = newFile('intent.sqlite');
    let clock = start;
    const first = createIntentStore({ filename, dailyLimit: 1, now: () => clock });
    const second = createIntentStore({ filename, dailyLimit: 1, now: () => clock });
    try {
        first.reserve(); clock += 60000;
        assert.throws(() => second.reserve(), /AI_DAILY_LIMIT/);
    } finally { first.close(); second.close(); }
});

test('cache is bounded, expires and rejects arbitrary actions', () => {
    let clock = start;
    const store = createIntentStore({ filename: ':memory:', maxEntries: 2, ttlMs: 1000, now: () => clock });
    try {
        for (let index = 0; index < 3; index++) { store.put(question(index), { action: 'stats', days: 3 }); clock++; }
        assert.equal(store.status().cacheEntries, 2);
        assert.equal(store.get(question(0)), null);
        assert.throws(() => store.put('bad', { action: 'delete_user', days: 3 }), /AI_STATE_UNAVAILABLE/);
        clock += 1000;
        assert.equal(store.get(question(2)), null);
        assert.equal(store.status().cacheEntries, 0);
    } finally { store.close(); }
});

test('SQLite stores hashes and intents, never raw questions or panel responses', () => {
    const filename = newFile('intent.sqlite');
    const store = createIntentStore({ filename });
    store.put('FAKE_PERSONAL_QUESTION', { action: 'stats', days: 3 });
    store.close();
    assert.ok(!readFileSync(filename).includes(Buffer.from('FAKE_PERSONAL_QUESTION')));
});

test('corrupt SQLite state fails closed instead of resetting the budget', () => {
    const filename = newFile('broken.sqlite');
    writeFileSync(filename, 'NOT_A_DATABASE');
    assert.throws(() => createIntentStore({ filename }), /AI_STATE_UNAVAILABLE/);
    assert.equal(readFileSync(filename, 'utf8'), 'NOT_A_DATABASE');
});

test('local text commands cost nothing and do not treat writes, dates or different numbers as safe reads', async () => {
    const store = createIntentStore({ filename: ':memory:' });
    try {
        const classify = createBudgetedIntent({ store });
        assert.deepEqual(await classify('У кого истекает подписка в ближайшую неделю?'), { action: 'expiring', days: 7 });
        assert.deepEqual(await classify('У кого истекает подписка в ближайшие три дня?'), { action: 'expiring', days: 3 });
        assert.deepEqual(await classify('Удали пользователя'), { action: 'help', days: 3 });
        assert.equal(localIntent('подписки до 15 октября'), null);
        await assert.rejects(classify(question(1)), /AI_NOT_CONFIGURED/);
        assert.equal(store.status().used, 0);
    } finally { store.close(); }
});

test('repeat text uses a real MCP read each time instead of caching stale panel statistics', async () => {
    const store = createIntentStore({ filename: ':memory:' });
    let reads = 0;
    const transport = await connectReportMcp({ stats: async () => ({ totalUsers: 10, usersOnline: ++reads, observedAt: new Date().toISOString() }) });
    let clock = start;
    try {
        const handle = createDashboard({ allowedUserId: 123456789, now: () => clock, classify: createBudgetedIntent({ store }), mcpRead: transport.read });
        const update = update_id => ({ update_id, message: { text: 'статистика', date: Math.floor(clock / 1000), chat: { type: 'private', id: 123456789 }, from: { id: 123456789, is_bot: false } } });
        const first = await handle(update(1)); clock += 5000;
        const second = await handle(update(2));
        assert.match(first.text, /Онлайн: <b>1/);
        assert.match(second.text, /Онлайн: <b>2/);
        assert.equal(reads, 2);
        assert.equal(store.status().used, 0);
    } finally { await transport.close(); store.close(); }
});

test('receiver conflict remains paused across a restart and requires explicit acknowledgement', () => {
    const directory = mkdtempSync(join(tmpdir(), 'panel-bot-safety-'));
    const first = createRunSafety({ directory, now: () => start });
    first.record({ status: 'blocked', reason: 'RECEIVER_CONFLICT' });
    const second = createRunSafety({ directory, now: () => start + 1000 });
    assert.equal(second.read().mode, 'paused');
    second.record({ status: 'stopped' });
    assert.equal(second.read().mode, 'paused');
    second.acknowledge();
    assert.equal(second.read().mode, 'active');
});

test('five consecutive short startup failures pause rather than create an endless restart loop', () => {
    const directory = mkdtempSync(join(tmpdir(), 'panel-bot-safety-'));
    let clock = start;
    const safety = createRunSafety({ directory, now: () => clock });
    for (let index = 0; index < 5; index++) {
        safety.record({ status: 'failed', startedAt: new Date(clock).toISOString(), stoppedAt: new Date(clock + 1000).toISOString() }); clock += 5000;
    }
    assert.equal(safety.read().reason, 'REPEATED_STARTUP_FAILURE');
});

test('corrupt pause state is not ignored and paused wait does not call external services', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'panel-bot-safety-'));
    writeFileSync(join(directory, 'receiver-safety.json'), 'broken');
    assert.equal(createRunSafety({ directory }).read().reason, 'SAFETY_STATE_UNAVAILABLE');
    const controller = new AbortController();
    const waiting = waitForOperator({ signal: controller.signal, heartbeat: () => {} });
    controller.abort(); await waiting;
});

test('parallel unknown questions cannot reserve extra AI attempts while one is running', async () => {
    const store = createIntentStore({ filename: ':memory:' });
    let finish;
    const classify = createBudgetedIntent({ store, classify: () => new Promise(resolve => { finish = resolve; }) });
    try {
        const pending = classify(question(1));
        await assert.rejects(classify(question(2)), /AI_BUSY/);
        assert.equal(store.status().used, 1);
        finish({ action: 'stats', days: 3 });
        await pending;
    } finally { store.close(); }
});

test('foreign chats cannot populate the cache, reserve budget or request budget status', async () => {
    const store = createIntentStore({ filename: ':memory:' });
    let calls = 0;
    try {
        const handle = createDashboard({ allowedUserId: 123456789, now: () => start, service: {}, budgetStatus: store.status, classify: createBudgetedIntent({ store, classify: async () => { calls++; } }), mcpRead: async () => { calls++; } });
        const message = text => ({ update_id: 1, message: { text, date: start / 1000, chat: { type: 'private', id: 987654321 }, from: { id: 987654321, is_bot: false } } });
        assert.equal(await handle(message(question(1))), null);
        assert.equal(await handle(message('/budget')), null);
        assert.equal(calls, 0);
        assert.equal(store.status().used, 0);
        assert.equal(store.status().cacheEntries, 0);
    } finally { store.close(); }
});

test('a learned question reads fresh data through MCP without a second AI reservation', async () => {
    const store = createIntentStore({ filename: ':memory:' });
    let reads = 0;
    let classifications = 0;
    let clock = start;
    const transport = await connectReportMcp({ stats: async () => ({ totalUsers: 10, usersOnline: ++reads, observedAt: new Date(clock).toISOString() }) });
    try {
        const handle = createDashboard({ allowedUserId: 123456789, now: () => clock, service: {}, classify: createBudgetedIntent({ store, classify: async () => { classifications++; return { action: 'stats', days: 3 }; } }), mcpRead: transport.read });
        const update = update_id => ({ update_id, message: { text: question(1), date: Math.floor(clock / 1000), chat: { type: 'private', id: 123456789 }, from: { id: 123456789, is_bot: false } } });
        assert.match((await handle(update(1))).text, /Онлайн: <b>1/);
        clock += 5000;
        assert.match((await handle(update(2))).text, /Онлайн: <b>2/);
        assert.equal(classifications, 1);
        assert.equal(store.status().used, 1);
    } finally { await transport.close(); store.close(); }
});
