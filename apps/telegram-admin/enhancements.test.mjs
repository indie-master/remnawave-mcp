import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import contract from '@remnawave/backend-contract';
import { resolveLocalRequest } from './local-router.mjs';
import { createIntentStore } from './intent-store.mjs';
import { createBudgetedIntent } from './budgeted-intent.mjs';
import { createPanelService } from './panel-service.mjs';
import { connectReportMcp, reportTools } from './report-mcp.mjs';
import { createDashboard } from './dashboard.mjs';
import { createMenuSession } from './menu-session.mjs';
import { createTelegramApi, TelegramError } from '../telegram-client/telegram-api.mjs';
import { extraView } from './extra-views.mjs';
import { readServerConfig } from './server-config.mjs';
import { runServerBot } from './server-loop.mjs';

const owner = 123456789;
const start = Date.UTC(2026, 9, 16, 10);
const message = (text, update_id = 1) => ({ update_id, message: { text, date: start / 1000, chat: { type: 'private', id: owner }, from: { id: owner, is_bot: false } } });
const callback = (data, message_id = 11, update_id = 2) => ({ update_id, callback_query: { id: `query_${update_id}`, data, from: { id: owner, is_bot: false }, message: { message_id, chat: { type: 'private', id: owner } } } });

test('natural local aliases separate user metrics from node metrics without AI', async () => {
    const groups = {
        stats: ['пришли статистику', 'Покажи статистику?', 'проверь статистику панели'],
        users: ['покажи количество пользователей', 'сколько юзеров', 'статистика пользователей', 'число клиентов', 'сводка о клиентах'],
        online: ['сколько юзеров онлайн', 'сколько пользователей сейчас онлайн', 'покажи онлайн сейчас'],
        nodes: ['статистика нод', 'статистика серверов', 'сколько нод', 'состояние серверов'],
        node_details: ['список нод', 'онлайн на нодах', 'сколько пользователей на нодах'],
        version: ['какая версия панели', 'покажи версию панели'],
    };
    const store = createIntentStore({ filename: ':memory:' });
    let calls = 0;
    const classify = createBudgetedIntent({ store, classify: async () => { calls++; throw new Error('MUST_NOT_CALL_AI'); } });
    try {
        for (const [action, phrases] of Object.entries(groups)) for (const phrase of phrases) {
            assert.equal(resolveLocalRequest(phrase)?.intent?.action, action, phrase);
            assert.equal((await classify(phrase)).action, action, phrase);
        }
        assert.equal(calls, 0);
        assert.equal(store.status().used, 0);
    } finally { store.close(); }
});

test('ambiguous filters, mixed subjects, unsupported dates and negations never fall through to AI or cached guesses', async () => {
    const store = createIntentStore({ filename: ':memory:' });
    let calls = 0;
    const classify = createBudgetedIntent({ store, classify: async () => { calls++; } });
    try {
        for (const phrase of ['статистика и ноды', 'подписки до 15 октября', 'подписки за 2 дня', 'подписки за 21 день', 'не показывай статистику', 'сколько пользователей на ноде 123', 'статистика пользователей за неделю', 'трафик по нодам', 'число клиентов с истекшей подпиской', 'количество клиентов активных']) {
            store.put(phrase, { action: 'stats', days: 3 });
            assert.equal(resolveLocalRequest(phrase)?.kind, 'clarify', phrase);
            await assert.rejects(classify(phrase), /LOCAL_CLARIFICATION_REQUIRED/);
        }
        assert.equal(calls, 0);
        assert.equal(store.status().used, 0);
    } finally { store.close(); }
});

test('writes stay blocked and context-dependent periods never become global cached meanings', () => {
    for (const phrase of ['удали пользователя', 'отключи ноду', 'продли подписку', 'перезапусти сервер', 'docker restart bot', 'отправь уведомления']) assert.equal(resolveLocalRequest(phrase).kind, 'blocked', phrase);
    assert.deepEqual(resolveLocalRequest('а за неделю?', { context: { action: 'expiring', days: 3 } }).intent, { action: 'expiring', days: 7 });
    assert.equal(resolveLocalRequest('а за неделю?').kind, 'clarify');
    assert.equal(resolveLocalRequest('а онлайн?', { context: { action: 'nodes' } }).intent.action, 'nodes');
    assert.equal(resolveLocalRequest('а онлайн?', { context: { action: 'users' } }).intent.action, 'online');
    assert.equal(resolveLocalRequest('а онлайн?').kind, 'clarify');
    assert.equal(resolveLocalRequest('а офлайн?', { context: { action: 'nodes' } }).intent.action, 'nodes');
    assert.equal(resolveLocalRequest('а всего?', { context: { action: 'online' } }).intent.action, 'users');
    assert.equal(resolveLocalRequest('а подробнее?', { context: { action: 'nodes' } }).intent.action, 'node_details');
    for (const phrase of ['а за 2 дня?', 'а за 21 день?', 'а до 15 октября?', '15.10.2026', 'а офлайн?']) assert.equal(resolveLocalRequest(phrase, { context: { action: 'users' } }).kind, 'clarify', phrase);
});

function reportsFixture() {
    const calls = [];
    const stat = { current: '12.45 GB', previous: '100 B' };
    const data = {
        '/api/system/stats': { cpu: { cores: 2 }, memory: { total: 4096, used: 1024, free: 3072 }, uptime: 7200, users: { totalUsers: 10, statusCounts: { ACTIVE: 7, DISABLED: 1, LIMITED: 1, EXPIRED: 1 } }, onlineStats: { onlineNow: 3, lastDay: 5, lastWeek: 7, neverOnline: 2 }, privateKey: 'PRIVATE_FIXTURE' },
        '/api/nodes/': [{ isConnected: true, isDisabled: false, isConnecting: false, usersOnline: 2, address: 'PRIVATE_FIXTURE', name: 'PRIVATE_FIXTURE' }],
        '/api/hosts/': [{ isDisabled: false, address: 'PRIVATE_FIXTURE' }, { isDisabled: true }],
        '/api/config-profiles/': { total: 1, configProfiles: [{ config: 'PRIVATE_FIXTURE' }] },
        '/api/internal-squads/': { total: 1, internalSquads: [{ name: 'PRIVATE_FIXTURE' }] },
        '/api/external-squads/': { total: 0, externalSquads: [] },
        '/api/system/stats/bandwidth': Object.fromEntries(['bandwidthLastTwoDays', 'bandwidthLastSevenDays', 'bandwidthLast30Days', 'bandwidthCalendarMonth', 'bandwidthCurrentYear'].map(key => [key, stat])),
        '/api/system/health': { runtimeMetrics: [{ uptime: 120, rss: 1024, eventLoopDelayMs: 0.1, pid: 99, instanceId: 'PRIVATE_FIXTURE' }] },
    };
    const service = createPanelService({ now: () => start, clientFactory: () => ({ request: async (method, path) => {
        assert.equal(method, 'GET'); calls.push(path); return data[path];
    } }) });
    return { service, calls, data };
}

test('new report paths match the installed 3.4.5 contract and expose only filtered fields', async () => {
    const { service, calls } = reportsFixture();
    const definitions = { users: contract.GetStatsCommand, online: contract.GetStatsCommand, system: contract.GetStatsCommand, node_details: contract.GetNodesCommand, hosts: contract.GetHostsCommand, profiles: contract.GetConfigProfilesCommand, internal_squads: contract.GetInternalSquadsCommand, external_squads: contract.GetExternalSquadsCommand, bandwidth: contract.GetBandwidthStatsCommand, health: contract.GetRemnawaveHealthCommand };
    for (const [action, definition] of Object.entries(definitions)) {
        assert.ok(definition?.url, action);
        assert.equal(definition.endpointDetails.REQUEST_METHOD, 'get');
        const report = await service[action]();
        assert.equal(calls.at(-1), definition.url);
        assert.equal(report.observedAt, new Date(start).toISOString());
        assert.ok(!JSON.stringify(report).includes('PRIVATE_FIXTURE'));
        const lines = extraView(action, report);
        assert.ok(lines.join('\n').length < 4096);
    }
});

test('missing, inconsistent and malformed new metrics are unavailable rather than zero', async () => {
    for (const [action, path, bad] of [
        ['users', '/api/system/stats', { users: { totalUsers: 10, statusCounts: {} } }],
        ['online', '/api/system/stats', { users: { totalUsers: 1 }, onlineStats: { onlineNow: 2 } }],
        ['profiles', '/api/config-profiles/', { total: 5, configProfiles: [] }],
        ['hosts', '/api/hosts/', [{}]],
        ['node_details', '/api/nodes/', [{ isConnected: true }]],
        ['bandwidth', '/api/system/stats/bandwidth', {}],
        ['health', '/api/system/health', { runtimeMetrics: [{ uptime: 1, rss: -1 }] }],
        ['health', '/api/system/health', { runtimeMetrics: [] }],
    ]) {
        const fixture = reportsFixture(); fixture.data[path] = bad;
        await assert.rejects(fixture.service[action](), /INVALID_PANEL_RESPONSE/, action);
    }
    const fixture = reportsFixture();
    fixture.data['/api/nodes/'][0].usersOnline = null;
    assert.equal((await fixture.service.node_details()).nodes[0].usersOnline, null);
    fixture.data['/api/system/stats/bandwidth'].bandwidthLastTwoDays = { current: '0', previous: '1.45' };
    assert.equal((await fixture.service.bandwidth()).periods.bandwidthLastTwoDays.current, '0');
    fixture.data['/api/system/stats/bandwidth'].bandwidthLastTwoDays = { current: '<b>12 GB</b>', previous: '0 B' };
    await assert.rejects(fixture.service.bandwidth(), /INVALID_PANEL_RESPONSE/);
});

test('new cached report actions cannot poison the legacy cache namespace on code rollback', () => {
    const filename = join(mkdtempSync(join(tmpdir(), 'panel-router-test-')), 'intents.sqlite');
    const store = createIntentStore({ filename, now: () => start });
    store.put('legacy question', { action: 'stats', days: 3 });
    store.put('new question', { action: 'online', days: 3 });
    assert.equal(store.get('legacy question').action, 'stats');
    assert.equal(store.get('new question').action, 'online');
    store.close();
    const database = new DatabaseSync(filename, { readOnly: true });
    try {
        const key = text => createHash('sha256').update('intent-v1\0' + text).digest('hex');
        assert.equal(database.prepare('SELECT action FROM intent_cache WHERE key=?').get(key('legacy question')).action, 'stats');
        assert.equal(database.prepare('SELECT action FROM intent_cache WHERE key=?').get(key('new question')), undefined);
    } finally { database.close(); }
});

test('all extra report tools work through real in-memory MCP without exposing secrets', async () => {
    const fixture = reportsFixture();
    const transport = await connectReportMcp(fixture.service);
    try {
        for (const action of Object.keys(reportTools).filter(action => !['stats', 'nodes', 'version', 'expiring'].includes(action))) {
            const report = await transport.read(action);
            assert.equal(report.observedAt, new Date(start).toISOString());
            assert.ok(!JSON.stringify(report).includes('PRIVATE_FIXTURE'));
        }
    } finally { await transport.close(); }
});

test('enhanced local routing, clarification and context work with AI disabled and unavailable SQLite', async () => {
    let clock = start;
    const fixture = reportsFixture();
    const handle = createDashboard({ allowedUserId: owner, service: fixture.service, enhancedUi: true, now: () => clock });
    assert.match((await handle(message('покажи количество пользователей'))).text, /Всего: <b>10/);
    clock += 5000;
    assert.match((await handle(message('а онлайн?', 2))).text, /Сейчас: <b>3/);
    clock += 5000;
    assert.match((await handle(message('статистика и ноды', 3))).text, /Уточните/);
    assert.equal(fixture.calls.length, 2);
    clock += 600001;
    const later = message('а онлайн?', 4); later.message.date = Math.floor(clock / 1000);
    assert.match((await handle(later)).text, /Уточните/);
    assert.equal(fixture.calls.length, 2);
});

test('enhanced menu is opt-in and every report button uses direct API, not classification', async () => {
    const fixture = reportsFixture();
    let clock = start;
    let classifications = 0;
    const handle = createDashboard({ allowedUserId: owner, service: fixture.service, enhancedUi: true, now: () => clock, classify: async () => { classifications++; } });
    const home = await handle(message('/menu'));
    assert.ok(home.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'q:online'));
    let updateId = 2;
    for (const action of ['users', 'online', 'node_details', 'system', 'bandwidth', 'health', 'hosts', 'profiles', 'internal_squads', 'external_squads']) {
        clock += 5000;
        assert.match((await handle(callback(`q:${action}`, 11, updateId++))).text, /Проверено:/);
    }
    assert.equal(classifications, 0);
    assert.equal(fixture.calls.length, 10);
    const env = { TELEGRAM_ADMIN_ID: String(owner), BOT_USERNAME: 'example_admin_bot' };
    assert.equal(readServerConfig(env).enhancedUi, false);
    assert.equal(readServerConfig({ ...env, BOT_ENHANCED_UI: 'true' }).enhancedUi, true);
    assert.throws(() => readServerConfig({ ...env, BOT_ENHANCED_UI: 'yes' }));
});

function menuFixture() {
    const sends = [];
    const edits = [];
    const acknowledgements = [];
    let calls = 0;
    let key = 0;
    const api = {
        sendReply: async payload => { sends.push(payload); return { message_id: 10 + sends.length, chat: { id: owner } }; },
        editReply: async payload => { edits.push(payload); },
        answerCallback: async id => { acknowledgements.push(id); },
    };
    const handle = createDashboard({ allowedUserId: owner, enhancedUi: true, service: { stats: async () => { calls++; return { totalUsers: 10, usersOnline: 2, observedAt: new Date(start).toISOString() }; } }, now: () => start, answerCallback: api.answerCallback });
    const session = createMenuSession({ api, handle, allowedUserId: owner, nonce: () => String(++key).padStart(8, '0') });
    return { api, session, sends, edits, acknowledgements, calls: () => calls };
}

test('menu navigation edits exactly its own message and rejects stale revisions without panel reads', async () => {
    const fixture = menuFixture();
    await fixture.session.process(message('/menu'));
    const action = fixture.sends[0].reply_markup.inline_keyboard[0][0].callback_data;
    await fixture.session.process(callback(action));
    assert.equal(fixture.sends.length, 1);
    assert.equal(fixture.edits.length, 1);
    assert.equal(fixture.edits[0].message_id, 11);
    assert.equal(fixture.calls(), 1);
    await fixture.session.process(callback(action, 11, 3));
    assert.equal(fixture.calls(), 1);
    assert.equal(fixture.edits.length, 1);
    const home = fixture.edits[0].reply_markup.inline_keyboard[0][1].callback_data;
    await fixture.session.process(callback(home, 11, 4));
    assert.equal(fixture.sends.length, 1);
    assert.equal(fixture.edits.length, 2);
    assert.equal(fixture.acknowledgements.length, 3);
});

test('old menus after restart, backups and foreign senders are never edited or executed', async () => {
    const fixture = menuFixture();
    await fixture.session.process(callback('q:stats', 999));
    assert.equal(fixture.calls(), 0);
    assert.equal(fixture.edits.length, 0);
    assert.equal(fixture.sends.length, 1);
    const foreign = callback('q:stats', 999, 3); foreign.callback_query.from.id++;
    await fixture.session.process(foreign);
    assert.equal(fixture.acknowledgements.length, 1);
    assert.equal(fixture.sends.length, 1);
});

test('only a definite unavailable edit falls back to sending, network uncertainty never duplicates', async () => {
    for (const code of ['EDIT_UNAVAILABLE', 'NETWORK_FAILED']) {
        const fixture = menuFixture();
        await fixture.session.process(message('/menu'));
        fixture.api.editReply = async () => { throw new TelegramError(code); };
        const action = fixture.sends[0].reply_markup.inline_keyboard[0][0].callback_data;
        if (code === 'NETWORK_FAILED') await assert.rejects(fixture.session.process(callback(action)), /NETWORK_FAILED/);
        else await fixture.session.process(callback(action));
        assert.equal(fixture.sends.length, code === 'NETWORK_FAILED' ? 1 : 2);
    }
});

test('edit transport validates owner, message ID, keyboard and safe error mappings', async () => {
    const requests = [];
    let response = { ok: true, result: { message_id: 11, chat: { id: owner } } };
    let status = 200;
    const api = createTelegramApi({ token: '123456789:' + 'A'.repeat(35), allowedUserId: owner, enableButtons: true, fetchImpl: async (url, options) => {
        requests.push({ method: url.split('/').at(-1), body: JSON.parse(options.body) });
        return new Response(JSON.stringify(response), { status });
    } });
    const payload = { chat_id: owner, message_id: 11, text: 'Меню', protect_content: true, parse_mode: 'HTML' };
    await api.editReply(payload);
    assert.equal(requests[0].method, 'editMessageText');
    assert.ok(!Object.hasOwn(requests[0].body, 'protect_content'));
    for (const patch of [{ chat_id: owner + 1 }, { message_id: 0 }, { message_id: '11' }, { inline_message_id: 'bad' }]) await assert.rejects(api.editReply({ ...payload, ...patch }), /REPLY_BLOCKED/);
    status = 400;
    response = { ok: false, description: 'Bad Request: message to edit not found' };
    await assert.rejects(api.editReply(payload), /EDIT_UNAVAILABLE/);
    response = { ok: false, description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message' };
    await api.editReply(payload);
    response = { ok: false, description: 'PRIVATE_FIXTURE' };
    await assert.rejects(api.editReply(payload), error => error.message === 'TELEGRAM_REQUEST_FAILED' && !JSON.stringify(error).includes('PRIVATE_FIXTURE'));
});

test('server loop persists offsets and uses edit transport for enhanced callbacks without touching notices', async () => {
    let clock = start;
    let polls = 0;
    const sent = [];
    const edits = [];
    const offsets = [];
    const ready = [];
    const api = {
        getMe: async () => ({ is_bot: true, username: 'example_admin_bot' }),
        getWebhookInfo: async () => ({ url: '' }),
        getUpdates: async () => {
            if (++polls === 1) return [message('/menu')];
            if (polls === 2) return [callback(sent[1].reply_markup.inline_keyboard[0][0].callback_data, 12)];
            clock += 61000; return [];
        },
        sendReply: async payload => { sent.push(payload); return { message_id: 10 + sent.length, chat: { id: owner } }; },
        editReply: async payload => { edits.push(payload); },
        answerCallback: async () => {},
    };
    const fixture = reportsFixture();
    const result = await runServerBot({ api, service: fixture.service, allowedUserId: owner, botUsername: 'example_admin_bot', soleReceiverConfirmed: true, seconds: 60, enhancedUi: true, now: () => clock, sleep: async () => {}, saveOffset: offset => offsets.push(offset), onReady: value => ready.push(value) });
    assert.equal(result.reason, 'TIME_LIMIT');
    assert.equal(sent.length, 3);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].message_id, 12);
    assert.deepEqual(offsets, [2, 3]);
    assert.equal(ready[0].enhancedUi, true);
    assert.equal(fixture.calls.length, 1);
});
