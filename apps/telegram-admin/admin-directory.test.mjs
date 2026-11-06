import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTelegramApi } from '../telegram-client/telegram-api.mjs';
import { createAdminHandler, createUserAdministration, createUserClient } from './admin-users.mjs';
import { createDashboard } from './dashboard.mjs';
import { createMenuSession } from './menu-session.mjs';
import { validateExtensionConfiguration } from './ops-config.mjs';

const actor = 123456789;
const nodeUuid = '123e4567-e89b-42d3-a456-426614174000';
const start = Date.parse('2035-01-01T00:00:00.000Z');
const observedAt = new Date(start).toISOString();
const url = 'https://subscription.example.invalid/synthetic-private-path';

function fixture(t, { allowed = true, failedWrite = false } = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'panel-directory-'));
    const readTokenFile = join(directory, 'read.txt');
    const writeTokenFile = join(directory, 'write.txt');
    writeFileSync(readTokenFile, 'synthetic-read');
    writeFileSync(writeTokenFile, 'synthetic-write');
    let now = start;
    const users = Array.from({ length: 10 }, (_, index) => ({ id: index + 40, username: `example_user_${index}`, status: 'ACTIVE', expireAt: '2035-02-01T00:00:00.000Z', subscriptionUrl: url, shortUuid: 'synthetic-short-id', hwidDeviceLimit: 3 }));
    const user = users[8];
    const node = { uuid: nodeUuid, name: 'Example <node>', isConnected: true, isConnecting: false, isDisabled: false, usersOnline: 4, note: null, proxyUrl: 'synthetic-hidden-proxy', updatedAt: observedAt };
    const devices = [{ hwid: 'SYNTHETIC_DEVICE_SECRET', userId: user.id, platform: 'Android', deviceModel: 'Example phone', osVersion: '16', userAgent: null, requestIp: '192.0.2.3', createdAt: observedAt, updatedAt: observedAt }];
    const reads = [];
    const writes = [];
    let resultTarget = user.id;
    let jobs = 0;
    let modelCalls = 0;
    const panelFetch = globalThis.fetch;
    globalThis.fetch = async (address, options) => {
        const parsed = new URL(address);
        assert.equal(parsed.origin, 'https://panel.example.invalid');
        assert.equal(options.redirect, 'error');
        const path = parsed.pathname;
        const method = options.method;
        const reply = response => Response.json({ response });
        if (options.headers.Authorization === 'Bearer synthetic-write') {
            const body = JSON.parse(options.body);
            writes.push({ method, path, body });
            if (failedWrite) throw new Error('NETWORK');
            if (path === '/api/users/' && method === 'PATCH') return reply(Object.assign(user, body));
            if (path === '/api/nodes/' && method === 'PATCH') return reply(Object.assign(node, body));
            if (path === `/api/users/${user.id}/actions/revoke` && method === 'POST') {
                user.subRevokedAt = new Date(now).toISOString();
                if (!body.revokeOnlyPasswords) user.shortUuid = 'another-synthetic-id';
                return reply(user);
            }
            if (path === '/api/hwid/devices/delete' && method === 'POST') { devices.length = 0; return reply({ total: 0, devices }); }
            throw new Error('UNEXPECTED_WRITE');
        }
        assert.equal(options.headers.Authorization, 'Bearer synthetic-read');
        reads.push({ path, method });
        if (path === '/api/users/') {
            assert.equal(method, 'GET');
            const first = Number(parsed.searchParams.get('start'));
            assert.equal(parsed.searchParams.get('size'), '8');
            assert.deepEqual(JSON.parse(parsed.searchParams.get('sorting')), [{ id: 'id', desc: false }]);
            return reply({ users: users.slice(first, first + 8), total: users.length });
        }
        if (/^\/api\/users\/\d+$/.test(path)) return reply(users.find(item => item.id === Number(path.split('/').at(-1))));
        if (path === `/api/hwid/devices/${user.id}`) return reply({ total: devices.length, devices });
        if (path === '/api/nodes/') return reply([node]);
        if (path === `/api/nodes/${nodeUuid}`) return reply(node);
        if (path === `/api/connections/by-user/${user.id}` && method === 'POST') { jobs++; return reply({ jobId: 'synthetic-job' }); }
        if (path === '/api/connections/by-user/synthetic-job' && method === 'GET') return reply({ isCompleted: true, isFailed: false, progress: { total: 1, completed: 1, percent: 100 }, result: { success: true, userId: resultTarget, nodes: [{ nodeUuid, nodeName: node.name, countryCode: 'DE', ips: [{ ip: '192.0.2.5', lastSeen: observedAt }] }] } });
        throw new Error('UNEXPECTED_READ');
    };
    const administration = createUserAdministration({ filename: ':memory:', actorId: actor, client: createUserClient({ baseUrl: 'https://panel.example.invalid', readTokenFile, writeTokenFile }), readEnabled: true, writeEnabled: true, allowedFields: ['status', 'expireAt', 'hwidDeviceLimit'], actionUserIds: allowed ? [user.id] : [], actionNodeUuids: allowed ? [nodeUuid] : [], now: () => now });
    t.after(() => { globalThis.fetch = panelFetch; administration.close(); unlinkSync(readTokenFile); unlinkSync(writeTokenFile); rmdirSync(directory); });
    const adminHandle = createAdminHandler({ administration, actorId: actor, now: () => now });
    const dashboard = createDashboard({ allowedUserId: actor, enhancedUi: true, adminDirectory: true, adminHandle, now: () => now,
        classify: async () => { modelCalls++; throw new Error('UNEXPECTED_AI'); },
        service: { stats: async () => ({ totalUsers: 10, usersOnline: 4, observedAt }), users: async () => ({ totalUsers: 10, statuses: { ACTIVE: 10, DISABLED: 0, LIMITED: 0, EXPIRED: 0 }, observedAt }), nodes: async () => ({ nodesTotal: 1, nodesOnline: 1, nodesOffline: 0, nodesDisabled: 0, nodesConnecting: 0, observedAt }) },
    });
    let screen;
    let sends = 0;
    let sequence = 0;
    let anchor = 10;
    const chat = { id: actor, type: 'private' };
    const from = { id: actor, is_bot: false };
    const api = createTelegramApi({ token: '123456789:' + 'A'.repeat(35), allowedUserId: actor, enableButtons: true, fetchImpl: async (address, options) => {
        const method = address.split('/').at(-1);
        const body = JSON.parse(options.body);
        if (method === 'sendMessage') { assert.equal(body.protect_content, true); sends++; anchor++; }
        else if (method === 'editMessageText') assert.equal(body.message_id, anchor);
        if (method !== 'answerCallbackQuery') { assert.equal(body.link_preview_options.is_disabled, true); screen = body; }
        return Response.json({ ok: true, result: { message_id: anchor, chat } });
    } });
    const session = createMenuSession({ api, handle: dashboard, allowedUserId: actor, collapsible: true });
    const actions = () => screen.reply_markup.inline_keyboard.flat().map(button => button.callback_data.slice(11));
    const click = async (action, sender = actor) => {
        const item = screen.reply_markup.inline_keyboard.flat().find(button => button.callback_data.slice(11).startsWith(action));
        assert.ok(item, `No button ${action}`);
        await session.process({ update_id: ++sequence, callback_query: { id: 'cb_' + sequence, data: item.callback_data, from: { ...from, id: sender }, message: { message_id: anchor, chat } } });
        return screen;
    };
    return { administration, user, node, devices, reads, writes, actions, click, open: () => session.open(dashboard.home()),
        send: async text => { await session.process({ update_id: ++sequence, message: { chat, from, date: now / 1000, text } }); return screen; },
        advance: (ms = 3000) => { now += ms; }, sends: () => sends, jobs: () => jobs, modelCalls: () => modelCalls, wrongConnectionTarget: () => { resultTarget++; },
    };
}

test('the consolidated menus edit one message and return from a user to the correct live page', async t => {
    const state = fixture(t);
    await state.open();
    assert.deepEqual(state.actions().slice(0, 2), ['q:stats', 'q:nodes']);
    assert.ok(!state.actions().includes('q:online'));
    await state.click('q:stats');
    for (const action of ['q:online', 'q:users', 'q:system', 'q:health', 'q:bandwidth', 'q:version']) assert.ok(state.actions().includes(action));
    const summary = await state.click('q:users');
    assert.doesNotMatch(summary.text, /онлайн/i);
    assert.match((await state.click('aul:0')).text, /страница 1\/2/);
    assert.match((await state.click('aul:1')).text, /страница 2\/2/);
    const card = await state.click('alc:48:1');
    assert.match(card.text, /example_user_8/);
    assert.ok(!card.text.includes(url));
    assert.ok(state.actions().includes('aul:1'));
    assert.match((await state.click('aul:1')).text, /страница 2\/2/);
    await state.click('q:users'); await state.click('stats_menu'); await state.click('home');
    assert.equal(state.sends(), 1);
    assert.equal(state.writes.length, 0);
    assert.equal(state.modelCalls(), 0);
});

test('manual Moscow expiry, date validation and renewal cancellation use existing one-use writes', async t => {
    const state = fixture(t);
    await state.open(); await state.click('q:stats'); await state.click('q:users'); await state.click('aul:0'); await state.click('aul:1'); await state.click('alc:48:1');
    await state.click('ar:48'); await state.click('adt:48');
    assert.match((await state.send('31.02.2035 14:45')).text, /некорректно/);
    await state.click('ar:48'); await state.click('adt:48');
    assert.match((await state.send('30.01.2035 14:45')).text, /позже текущего окончания/);
    state.advance();
    await state.click('ar:48'); await state.click('adt:48');
    assert.match((await state.send('05.02.2035 14:45')).text, /2035-02-05T11:45:00.000Z/);
    assert.equal(state.writes.length, 0);
    await state.click('ac:', actor + 1);
    assert.equal(state.writes.length, 0);
    assert.match((await state.click('ac:')).text, /подтверждено панелью/);
    assert.deepEqual(state.writes.map(write => write.body), [{ id: 48, expireAt: '2035-02-05T11:45:00.000Z' }]);
    state.advance();
    await state.click('au:48'); await state.click('ar:48'); await state.click('ap:48:1');
    assert.match((await state.click('ax:')).text, /Выберите срок/);
    assert.equal(state.writes.length, 1);
    assert.equal(state.modelCalls(), 0);
});

test('new subscription links remain hidden until disclosed; revoke modes are targeted and opt-in', async t => {
    const state = fixture(t);
    await state.send('пользователь 48'); await state.click('as:48');
    assert.ok(!(await state.click('al:48')).text.includes(url));
    assert.ok((await state.click('ac:')).text.includes(url));
    assert.equal(state.writes.length, 0);
    await state.click('as:48'); await state.click('ars:48');
    assert.match((await state.click('ak:48:keys')).text, /Ссылка останется прежней/);
    await state.click('ac:');
    await state.click('as:48'); await state.click('ars:48');
    assert.match((await state.click('ak:48:rotate')).text, /старую ссылку/);
    assert.ok(!(await state.click('ac:')).text.includes(url));
    assert.deepEqual(state.writes.map(write => write.body), [{ revokeOnlyPasswords: true }, { revokeOnlyPasswords: false }]);
    await assert.rejects(state.administration.prepareAction(actor, '49', 'revoke', 'rotate'), /ADMIN_ACTION_DISABLED/);
    assert.equal(state.modelCalls(), 0);
});

test('HWID removal uses a selector, checks the same registration again and cannot repeat an uncertain write', async t => {
    const state = fixture(t, { failedWrite: true });
    await state.send('пользователь 48');
    const devices = await state.click('ah:48:0');
    assert.match(devices.text, /Зарегистрировано: 1/);
    assert.doesNotMatch(JSON.stringify(devices), /SYNTHETIC_DEVICE_SECRET|192\.0\.2\.3/);
    const preview = await state.click('ahd:48:');
    assert.match(preview.text, /Example phone/);
    assert.equal(state.writes.length, 0);
    const first = state.actions().find(action => action.startsWith('ac:')).slice(3);
    state.devices[0].createdAt = new Date(start + 1).toISOString();
    assert.match((await state.click('ac:')).text, /изменились/);
    assert.equal(state.administration.receipt(actor, first), 'rejected');
    assert.equal(state.writes.length, 0);
    await state.click('au:48'); await state.click('ah:48:0'); await state.click('ahd:48:');
    const second = state.actions().find(action => action.startsWith('ac:')).slice(3);
    await state.click('ac:');
    assert.equal(state.administration.receipt(actor, second), 'uncertain');
    await assert.rejects(state.administration.confirm(actor, second), /ADMIN_CONFIRMATION_EXPIRED/);
    assert.deepEqual(state.writes.map(write => write.body), [{ userId: 48, hwid: 'SYNTHETIC_DEVICE_SECRET' }]);
});

test('successful HWID removal updates the device list and preserves the limit setting', async t => {
    const state = fixture(t);
    await state.send('пользователь 48'); await state.click('ah:48:0'); await state.click('ahd:48:');
    assert.match((await state.click('ac:')).text, /подтверждено панелью/);
    assert.match((await state.click('ah:48:0')).text, /Зарегистрировано: 0/);
    assert.equal(state.user.hwidDeviceLimit, 3);
    await state.click('ahl:48'); await state.send('5'); await state.click('ac:');
    assert.equal(state.user.hwidDeviceLimit, 5);
    assert.equal(state.writes.length, 2);
});

test('connection results are polled only on click, checked against the user, and hide raw addresses', async t => {
    const state = fixture(t);
    await state.send('пользователь 48');
    assert.match((await state.click('aj:48:start')).text, /Проверить результат/);
    assert.equal(state.jobs(), 1);
    assert.equal(state.reads.filter(read => read.path.endsWith('synthetic-job')).length, 0);
    state.advance();
    const connections = await state.click('aj:48:check');
    assert.match(connections.text, /Example &lt;node&gt; · адресов: 1/);
    assert.doesNotMatch(connections.text, /192\.0\.2\.5/);
    state.advance(); await state.click('aj:48:start'); state.advance(); state.wrongConnectionTarget();
    assert.match((await state.click('aj:48:check')).text, /Операция недоступна/);
    assert.equal(state.writes.length, 0);
    assert.equal(state.modelCalls(), 0);
});

test('named node cards keep addresses private and only permitted metadata reaches the write endpoint', async t => {
    const state = fixture(t);
    await state.open(); await state.click('q:nodes'); await state.click('anl:0');
    assert.match((await state.click(`an:${nodeUuid}`)).text, /Example &lt;node&gt;/);
    assert.doesNotMatch((await state.click(`anm:${nodeUuid}`)).text, /synthetic-hidden-proxy/);
    await assert.rejects(state.administration.prepareNodeEdit(actor, nodeUuid, 'address', 'example.invalid'), /ADMIN_INVALID_CHANGE/);
    await state.click(`anf:${nodeUuid}:note`);
    await state.send('Новая заметка');
    assert.equal(state.writes.length, 0);
    assert.match((await state.click('ac:')).text, /подтверждено панелью/);
    assert.deepEqual(state.writes, [{ method: 'PATCH', path: '/api/nodes/', body: { uuid: nodeUuid, note: 'Новая заметка' } }]);
    await state.click(`an:${nodeUuid}`); await state.click('anl:0'); await state.click('q:nodes'); await state.click('home');
    assert.equal(state.modelCalls(), 0);
});

test('new writes default off and target configuration rejects wildcards, invalid IDs and duplicates', async t => {
    const state = fixture(t, { allowed: false });
    await state.send('пользователь 48'); await state.click('as:48');
    assert.ok(!state.actions().includes('ars:48'));
    assert.deepEqual(validateExtensionConfiguration('ADMIN_ACTION_USER_IDS=none\n').actionUserIds, []);
    for (const value of ['*', '48,48', '0', '048']) assert.throws(() => validateExtensionConfiguration(`ADMIN_ACTION_USER_IDS=${value}`));
    assert.throws(() => validateExtensionConfiguration('ADMIN_ACTION_NODE_UUIDS=all'));
    assert.deepEqual(validateExtensionConfiguration(`ADMIN_ACTION_NODE_UUIDS=${nodeUuid}`).actionNodeUuids, [nodeUuid]);
    await assert.rejects(state.administration.prepareNodeEdit(actor, nodeUuid, 'note', 'no'), /ADMIN_ACTION_DISABLED/);
    assert.equal(state.writes.length, 0);
});
