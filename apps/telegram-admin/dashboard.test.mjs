import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPanelService } from './panel-service.mjs';
import { createDashboard } from './dashboard.mjs';
import { createTelegramApi } from '../telegram-client/telegram-api.mjs';

const now = Date.UTC(2026, 9, 14, 13);
const observedAt = new Date(now).toISOString();
const owner = 123456789;
const user = (id, hours = 24, extra = {}) => ({ id, username: `client-${id}`, status: 'ACTIVE', expireAt: new Date(now + hours * 3600000).toISOString(), trafficLimitBytes: 0, userTraffic: { usedTrafficBytes: 1024 }, telegramId: owner, vlessUuid: 'FAKE_SECRET', subscriptionUrl: 'FAKE_SECRET', email: 'FAKE_PRIVATE_EMAIL', ...extra });
const message = (text, update_id = 1, override = {}) => ({ update_id, message: { text, date: now / 1000, chat: { type: 'private', id: owner }, from: { id: owner, is_bot: false }, ...override } });
const callback = (data, update_id = 1, override = {}) => ({ update_id, callback_query: { id: `query_${update_id}`, data, from: { id: owner, is_bot: false }, message: { chat: { type: 'private', id: owner } }, ...override } });

function fixture(users = [user(1)]) {
    const requests = [];
    const service = createPanelService({ usersEnabled: true, now: () => now, clientFactory: () => ({
        async request(method, path, query) {
            assert.equal(method, 'GET');
            requests.push({ method, path, query });
            if (path === '/api/system/metadata') return { version: '3.4.5', secret: 'FAKE_SECRET' };
            if (path === '/api/system/stats') return { users: { totalUsers: 10 }, onlineStats: { onlineNow: 6 }, secret: 'FAKE_SECRET' };
            if (path === '/api/nodes/') return [{ isConnected: true, privateKey: 'FAKE_SECRET' }];
            assert.equal(path, '/api/users/');
            return { total: users.length, users: users.slice(query.start, query.start + query.size) };
        },
    }) });
    return { requests, service };
}

test('direct report service exposes only whitelisted GET data without credentials', async () => {
    const { service, requests } = fixture();
    for (const action of ['version', 'stats', 'nodes', 'expiring']) {
        const data = await service[action]();
        assert.ok(!JSON.stringify(data).includes('FAKE_SECRET'));
        assert.ok(!JSON.stringify(data).includes('FAKE_PRIVATE_EMAIL'));
        assert.ok(!JSON.stringify(data).includes(String(owner)));
        assert.equal(data.observedAt, observedAt);
    }
    assert.deepEqual(requests.map(request => request.path), ['/api/system/metadata', '/api/system/stats', '/api/nodes/', '/api/users/']);
});

test('users read feature is blocked before opening a credential or making any request', async () => {
    let factories = 0;
    const service = createPanelService({ clientFactory: () => { factories++; }, usersEnabled: false });
    await assert.rejects(service.expiring(), /USERS_READ_NOT_ENABLED/);
    assert.equal(factories, 0);
});

test('expiry uses bounded future windows and excludes expired or inactive subscriptions', async () => {
    const { service } = fixture([user(1, -1), user(2, 0), user(3, 72), user(4, 73), user(5, 1, { status: 'DISABLED' })]);
    const report = await service.expiring({ days: 3 });
    assert.deepEqual(report.users.map(item => item.id), [2, 3]);
    assert.equal(report.complete, true);
    await assert.rejects(service.expiring({ days: 999 }), /INVALID_EXPIRY_WINDOW/);
});

test('pagination has hard caps and identifies partial results honestly', async () => {
    let calls = 0;
    const service = createPanelService({ usersEnabled: true, now: () => now, pageSize: 2, maxPages: 2, clientFactory: () => ({
        async request(method, path, query) { calls++; return { total: 100, users: [user(query.start + 1), user(query.start + 2)] }; },
    }) });
    const report = await service.expiring();
    assert.equal(calls, 2);
    assert.equal(report.complete, false);
    assert.equal(report.scanned, 4);
    assert.equal(report.total, 100);
});

test('changing totals and duplicate pages do not masquerade as complete reports', async () => {
    for (const duplicate of [false, true]) {
        const service = createPanelService({ usersEnabled: true, now: () => now, pageSize: 1, clientFactory: () => ({
            async request(method, path, query) { return { total: query.start > 0 && !duplicate ? 3 : 2, users: [user(1)] }; },
        }) });
        await assert.rejects(service.expiring(), duplicate ? /INVALID_PANEL_RESPONSE/ : /USER_LIST_CHANGED_RETRY/);
    }
});

test('static buttons and commands call direct API service, never AI or MCP', async () => {
    for (const action of ['stats', 'nodes', 'version', 'expiring']) {
        const { service, requests } = fixture();
        let aiCalls = 0;
        let mcpCalls = 0;
        const handle = createDashboard({ allowedUserId: owner, service, now: () => now, classify: async () => { aiCalls++; }, mcpRead: async () => { mcpCalls++; } });
        const reply = await handle(callback(`q:${action}${action === 'expiring' ? ':3' : ''}`));
        assert.ok(reply.text);
        assert.equal(requests.length, 1);
        assert.equal(aiCalls, 0);
        assert.equal(mcpCalls, 0);
    }
});


test('groups, foreign users and callback spoofing do not call API, AI, MCP or callback acknowledgement', async () => {
    const { service, requests } = fixture();
    let calls = 0;
    const handle = createDashboard({ allowedUserId: owner, service, now: () => now, classify: async () => { calls++; }, mcpRead: async () => { calls++; }, answerCallback: async () => { calls++; } });
    assert.equal(await handle(message('Статистика', 1, { chat: { type: 'group', id: owner } })), null);
    assert.equal(await handle(message('Статистика', 2, { from: { id: owner + 1, is_bot: false } })), null);
    assert.equal(await handle(callback('q:stats', 3, { from: { id: owner + 1, is_bot: false } })), null);
    assert.equal(calls, 0);
    assert.equal(requests.length, 0);
});

test('draft confirmation is owner-only and never creates customer delivery', async () => {
    const { service, requests } = fixture();
    let key = 0;
    const handle = createDashboard({ allowedUserId: owner, service, now: () => now, nonce: () => `snapshot_${++key}` });
    const report = await handle(callback('q:expiring:3', 1));
    const draftAction = report.reply_markup.inline_keyboard[0][0].callback_data;
    const draft = await handle(callback(draftAction, 2));
    assert.match(draft.text, /Сообщение не отправлено/);
    const approval = draft.reply_markup.inline_keyboard[0][0].callback_data;
    const confirmed = await handle(callback(approval, 3));
    assert.equal(confirmed.chat_id, owner);
    assert.match(confirmed.text, /Клиенту ничего не отправлено/);
    assert.equal(requests.length, 1);
    assert.equal((await handle(callback(approval, 4))).chat_id, owner);
});

test('HTML is escaped and reports paginate inside Telegram length limits', async () => {
    const { service } = fixture(Array.from({ length: 12 }, (_, index) => user(index + 1, 24, { username: '&'.repeat(80) })));
    const handle = createDashboard({ allowedUserId: owner, service, now: () => now });
    const reply = await handle(callback('q:expiring:3'));
    assert.ok(reply.text.length <= 4096);
    assert.match(reply.text, /&amp;/);
    assert.match(reply.text, /страница 1\/3/);
    assert.equal(reply.reply_markup.inline_keyboard.filter(row => row[0].text.startsWith('📝')).length, 5);
});



test('button transport permits only owner HTML replies and safe callback keyboards', async () => {
    const requests = [];
    const api = createTelegramApi({ token: '123456789:' + 'A'.repeat(35), allowedUserId: owner, enableButtons: true, fetchImpl: async (address, options) => {
        requests.push({ method: address.split('/').at(-1), body: JSON.parse(options.body) });
        return new Response('{"ok":true,"result":true}');
    } });
    const { service } = fixture();
    const handle = createDashboard({ allowedUserId: owner, service, now: () => now });
    await api.sendReply(await handle(message('/menu')));
    await api.answerCallback('query_1');
    assert.deepEqual(requests.map(request => request.method), ['sendMessage', 'answerCallbackQuery']);
    await assert.rejects(api.sendReply({ chat_id: owner + 1, text: 'test', protect_content: true }), /REPLY_BLOCKED/);
    await assert.rejects(api.sendReply({ chat_id: owner, text: 'test', protect_content: true, reply_markup: { inline_keyboard: [[{ text: 'bad', url: 'https://example.invalid' }]] } }), /REPLY_BLOCKED/);
});
