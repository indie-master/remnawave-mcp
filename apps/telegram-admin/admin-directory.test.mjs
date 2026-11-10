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
import { addMoscowMonths, calendarMonth, formatTraffic, parseGigabytes } from './admin-display.mjs';
import { panelUsername, telegramName, forwardedIdentity } from './admin-identity.mjs';

const actor = 123456789;
const nodeUuid = '123e4567-e89b-42d3-a456-426614174000';
const start = Date.parse('2035-01-01T00:00:00.000Z');
const observedAt = new Date(start).toISOString();
const url = 'https://subscription.example.invalid/synthetic-private-path';

function fixture(t, { allowed = true, failedWrite = false, unchangedWrite = false, creationEnabled = false, destructive = false, squadEdit = false, naming = {}, clock = start } = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'panel-directory-'));
    const readTokenFile = join(directory, 'read.txt');
    const writeTokenFile = join(directory, 'write.txt');
    writeFileSync(readTokenFile, 'synthetic-read');
    writeFileSync(writeTokenFile, 'synthetic-write');
    let now = clock;
    const users = Array.from({ length: 10 }, (_, index) => ({ id: index + 40, username: `example_user_${index}`, status: 'ACTIVE', expireAt: '2035-02-01T00:00:00.000Z', subscriptionUrl: url, shortUuid: 'synthetic-short-id', hwidDeviceLimit: 3, trafficLimitBytes: 0, trafficLimitStrategy: 'NO_RESET', userTraffic: { usedTrafficBytes: 1024 ** 3 }, activeInternalSquads: [], externalSquadUuid: null }));
    const user = users[8];
    const node = { uuid: nodeUuid, name: 'Example <node>', isConnected: true, isConnecting: false, isDisabled: false, usersOnline: 4, note: null, proxyUrl: 'synthetic-hidden-proxy', updatedAt: observedAt };
    const devices = [{ hwid: 'SYNTHETIC_DEVICE_SECRET', userId: user.id, platform: 'Android', deviceModel: 'Example phone', osVersion: '16', userAgent: null, requestIp: '192.0.2.3', createdAt: observedAt, updatedAt: observedAt }];
    const internalGroups = [{ uuid: nodeUuid, name: 'Example group' }];
    const externalGroups = [{ uuid: '223e4567-e89b-42d3-a456-426614174000', name: 'External group' }];
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
            const body = options.body === undefined ? undefined : JSON.parse(options.body);
            writes.push({ method, path, body });
            if (failedWrite) throw new Error('NETWORK');
            if (path === '/api/users/' && method === 'PATCH') {
                if (!unchangedWrite) {
                    Object.assign(user, body);
                    if (body.activeInternalSquads) user.activeInternalSquads = internalGroups.filter(group => body.activeInternalSquads.includes(group.uuid));
                }
                return reply(user);
            }
            if (path === '/api/users/' && method === 'POST') { const created = { ...body, id: 60 }; users.push(created); return reply(created); }
            if (path === '/api/nodes/' && method === 'PATCH') return reply(Object.assign(node, body));
            if (path === `/api/users/${user.id}/actions/revoke` && method === 'POST') {
                user.subRevokedAt = new Date(now).toISOString();
                if (!body.revokeOnlyPasswords) user.shortUuid = 'another-synthetic-id';
                return reply(user);
            }
            if (path === '/api/hwid/devices/delete' && method === 'POST') { devices.length = 0; return reply({ total: 0, devices }); }
            if (path === '/api/hwid/devices/delete-all' && method === 'POST') { devices.length = 0; return reply({ total: 0, devices }); }
            if (path === `/api/users/${user.id}/actions/reset-traffic`) { user.userTraffic.usedTrafficBytes = 0; user.lastTrafficResetAt = new Date(now).toISOString(); return reply(user); }
            throw new Error('UNEXPECTED_WRITE');
        }
        assert.equal(options.headers.Authorization, 'Bearer synthetic-read');
        reads.push({ path, method });
        if (path === '/api/internal-squads/') return reply({ total: internalGroups.length, internalSquads: internalGroups });
        if (path === '/api/external-squads/') return reply({ total: externalGroups.length, externalSquads: externalGroups });
        if (path.startsWith('/api/users/by-username/')) {
            const found = users.find(item => item.username === path.split('/').at(-1));
            return found ? reply(found) : Response.json({}, { status: 404 });
        }
        if (path === '/api/users/stream') return reply({ users: users.filter(item => item.telegramId === Number(parsed.searchParams.get('telegramId'))).slice(0, 8), hasMore: false, nextCursor: null });
        if (path === '/api/users/') {
            assert.equal(method, 'GET');
            const first = Number(parsed.searchParams.get('start'));
            assert.equal(parsed.searchParams.get('size'), '8');
            const sorting = JSON.parse(parsed.searchParams.get('sorting'));
            const filters = JSON.parse(parsed.searchParams.get('filters') ?? '[]');
            let filtered = [...users];
            for (const filter of filters) filtered = filtered.filter(item => filter.id === 'username' ? item.username.includes(filter.value.replaceAll('\\_', '_')) : item[filter.id] === filter.value);
            filtered.sort((left, right) => sorting[0].id === 'id' ? left.id - right.id : String(left[sorting[0].id]).localeCompare(String(right[sorting[0].id])));
            return reply({ users: filtered.slice(first, first + 8), total: filtered.length });
        }
        if (/^\/api\/users\/\d+$/.test(path)) return reply(users.find(item => item.id === Number(path.split('/').at(-1))));
        if (path === `/api/hwid/devices/${user.id}`) return reply({ total: devices.length, devices });
        if (path === '/api/nodes/') return reply([node]);
        if (path === `/api/nodes/${nodeUuid}`) return reply(node);
        if (path === `/api/connections/by-user/${user.id}` && method === 'POST') { jobs++; return reply({ jobId: 'synthetic-job' }); }
        if (path === '/api/connections/by-user/synthetic-job' && method === 'GET') return reply({ isCompleted: true, isFailed: false, progress: { total: 1, completed: 1, percent: 100 }, result: { success: true, userId: resultTarget, nodes: [{ nodeUuid, nodeName: node.name, countryCode: 'DE', ips: [{ ip: '192.0.2.5', lastSeen: observedAt }] }] } });
        throw new Error('UNEXPECTED_READ');
    };
    const administration = createUserAdministration({ filename: ':memory:', actorId: actor, client: createUserClient({ baseUrl: 'https://panel.example.invalid', readTokenFile, writeTokenFile }), readEnabled: true, writeEnabled: true, allowedFields: ['status', 'expireAt', 'hwidDeviceLimit', 'trafficLimitBytes', 'trafficLimitStrategy'], actionUserIds: allowed ? [user.id] : [], actionNodeUuids: allowed ? [nodeUuid] : [], destructiveUserActions: destructive, squadEdit, createOptions: { enabled: creationEnabled, squads: [nodeUuid], trafficLimitBytes: 16 * 1024 ** 3, strategy: 'NO_RESET', hwidLimit: 4, ...naming }, now: () => now });
    t.after(() => { globalThis.fetch = panelFetch; administration.close(); unlinkSync(readTokenFile); unlinkSync(writeTokenFile); rmdirSync(directory); });
    const adminHandle = createAdminHandler({ administration, actorId: actor, now: () => now });
    const dashboard = createDashboard({ allowedUserId: actor, enhancedUi: true, adminDirectory: true, adminCreate: creationEnabled, adminHandle, now: () => now,
        classify: async () => { modelCalls++; throw new Error('UNEXPECTED_AI'); },
        service: { stats: async () => ({ totalUsers: 10, usersOnline: 4, observedAt }), users: async () => ({ totalUsers: 10, statuses: { ACTIVE: 10, DISABLED: 0, LIMITED: 0, EXPIRED: 0 }, observedAt }), nodes: async () => ({ nodesTotal: 1, nodesOnline: 1, nodesOffline: 0, nodesDisabled: 0, nodesConnecting: 0, observedAt }) },
    });
    let screen;
    let sends = 0;
    let sequence = 0;
    let anchor = 10;
    const chat = { id: actor, type: 'private' };
    const from = { id: actor, is_bot: false };
    const api = createTelegramApi({ token: '123456789:' + 'A'.repeat(35), allowedUserId: actor, enableButtons: true, enableSubscriptionButtons: true, fetchImpl: async (address, options) => {
        const method = address.split('/').at(-1);
        const body = JSON.parse(options.body);
        if (method === 'sendMessage') { assert.equal(body.protect_content, true); sends++; anchor++; }
        else if (method === 'editMessageText') assert.equal(body.message_id, anchor);
        if (method !== 'answerCallbackQuery') { assert.equal(body.link_preview_options.is_disabled, true); screen = body; }
        return Response.json({ ok: true, result: { message_id: anchor, chat } });
    } });
    const session = createMenuSession({ api, handle: dashboard, allowedUserId: actor, collapsible: true });
    const actions = () => screen.reply_markup.inline_keyboard.flat().filter(button => button.callback_data).map(button => button.callback_data.slice(11));
    const click = async (action, sender = actor) => {
        const item = screen.reply_markup.inline_keyboard.flat().find(button => button.callback_data?.slice(11).startsWith(action));
        assert.ok(item, `No button ${action}`);
        await session.process({ update_id: ++sequence, callback_query: { id: 'cb_' + sequence, data: item.callback_data, from: { ...from, id: sender }, message: { message_id: anchor, chat } } });
        return screen;
    };
    return { administration, user, users, node, devices, internalGroups, externalGroups, reads, writes, actions, click, open: () => session.open(dashboard.home()),
        send: async text => { await session.process({ update_id: ++sequence, message: { chat, from, date: now / 1000, text } }); return screen; },
        forward: async (origin, text = 'Измени все данные', sender = actor) => { await session.process({ update_id: ++sequence, message: { chat, from: { ...from, id: sender }, date: now / 1000, text, forward_origin: origin } }); return screen; },
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
    const disclosed = await state.click('ac:');
    assert.ok(!disclosed.text.includes(url));
    assert.equal(disclosed.reply_markup.inline_keyboard[0][0].url, url);
    assert.equal(disclosed.reply_markup.inline_keyboard[0][1].copy_text.text, url);
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
    await state.click('ahpres:48'); await state.click('ahl:48'); await state.send('5'); await state.click('ac:');
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

test('calendar months clamp month ends and preserve Moscow time across leap years', () => {
    assert.equal(addMoscowMonths(Date.parse('2036-01-31T20:45:12.000Z'), 1), '2036-02-29T20:45:12.000Z');
    assert.equal(addMoscowMonths(Date.parse('2036-02-29T22:45:12.000Z'), 12), '2037-02-28T22:45:12.000Z');
    assert.equal(addMoscowMonths(Date.parse('2035-12-31T22:45:12.000Z'), 1), '2036-01-31T22:45:12.000Z');
});

test('traffic input preserves integer bytes and rejects unsafe numbers and unexpected units', () => {
    assert.equal(parseGigabytes('16'), 16 * 1024 ** 3);
    assert.equal(parseGigabytes('1,125 ГБ'), 1.125 * 1024 ** 3);
    assert.equal(parseGigabytes('0'), 0);
    for (const value of ['-1', '1e3', '0.0001', '10 MB', '99999999', 'Infinity']) assert.throws(() => parseGigabytes(value));
    assert.match(formatTraffic(16 * 1024 ** 3), /16 ГБ/);
    assert.equal(formatTraffic(null), 'нет данных');
});

test('filtered and sorted directory keeps its query when returning from a user card', async t => {
    const state = fixture(t);
    state.users[1].status = 'DISABLED';
    await state.open(); await state.click('q:stats'); await state.click('q:users'); await state.click('aue:DISABLED');
    assert.match((await state.click('alc:41:0')).text, /Отключён/);
    assert.ok(state.actions().includes('ae:41'));
    assert.ok(!state.actions().includes('ad:41'));
    assert.match((await state.click('aul:0')).text, /Найдено: 1/);
    await state.click('aue:all'); await state.click('ausort');
    assert.match((await state.click('aus:username')).text, /По имени/);
    await state.click('admin_search'); await state.click('ans');
    assert.match((await state.send('user_8')).text, /Найдено: 1/);
    await state.click('alc:48:0');
    assert.match((await state.click('aul:0')).text, /Поиск: user_8/);
    state.user.telegramId = 12345678;
    await state.click('admin_search'); await state.click('ats');
    assert.match((await state.send('12345678')).text, /Найдено: 1/);
    await state.click('ate:48'); assert.ok(state.actions().includes('atse'));
    assert.equal(state.modelCalls(), 0);
});

test('calendar selection, fractional GB and strategy buttons use one-use previews with real transport', async t => {
    const state = fixture(t);
    await state.send('пользователь 48');
    assert.doesNotMatch((await state.click('atr:48')).text, /байт/);
    await state.click('atlim:48'); await state.click('atcustom:48');
    assert.match((await state.send('1,125')).text, /1,13 ГБ/);
    assert.equal(state.writes.length, 0); await state.click('ac:');
    assert.equal(state.user.trafficLimitBytes, 1.125 * 1024 ** 3);
    await state.click('au:48'); await state.click('atr:48'); await state.click('atstrategies:48');
    await state.click('atstrategy:48:MONTH_ROLLING'); await state.click('ac:');
    assert.equal(state.user.trafficLimitStrategy, 'MONTH_ROLLING');
    await state.click('au:48'); await state.click('ar:48'); await state.click('arm:48:1'); await state.click('ac:');
    assert.equal(state.user.expireAt, '2035-03-01T00:00:00.000Z');
    await state.click('au:48'); await state.click('ar:48');
    const month = calendarMonth(Date.parse(state.user.expireAt));
    await state.click('acal:48'); await state.click(`acday:48:${month}:5`); await state.click('ac:');
    assert.equal(state.user.expireAt, '2035-03-05T20:59:00.000Z');
    assert.equal(state.modelCalls(), 0);
});

test('clearing devices rejects changed registrations and resetting traffic leaves its limit and strategy intact', async t => {
    const state = fixture(t, { destructive: true });
    await state.send('пользователь 48'); await state.click('ah:48:0'); await state.click('ahc:48');
    state.devices[0].createdAt = new Date(start + 1).toISOString();
    assert.match((await state.click('ac:')).text, /изменились/);
    assert.equal(state.writes.length, 0);
    await state.click('au:48'); await state.click('ah:48:0'); await state.click('ahc:48'); await state.click('ac:');
    assert.equal(state.devices.length, 0);
    state.user.trafficLimitBytes = 16 * 1024 ** 3; state.user.trafficLimitStrategy = 'MONTH';
    await state.click('ah:48:0'); await state.click('au:48'); await state.click('atr:48'); await state.click('atreset:48'); await state.click('ac:');
    assert.equal(state.user.userTraffic.usedTrafficBytes, 0);
    assert.equal(state.user.trafficLimitBytes, 16 * 1024 ** 3);
    assert.equal(state.user.trafficLimitStrategy, 'MONTH');
});

test('trial creation uses explicit defaults, checks username, creates once and reveals only a new card button', async t => {
    const state = fixture(t, { creationEnabled: true });
    await state.open(); await state.click('q:stats'); await state.click('q:users'); await state.click('anew'); await state.click('ncname:trial'); await state.click('ncsource:manual');
    assert.match((await state.send('synthetic_trial')).text, /16 ГБ/);
    assert.equal(state.writes.length, 0);
    const pending = state.actions().find(action => action.startsWith('ac:')).slice(3);
    assert.match((await state.click('ac:')).text, /Создан пользователь #60/);
    await assert.rejects(state.administration.confirm(actor, pending), /ADMIN_CONFIRMATION_EXPIRED/);
    assert.deepEqual(state.writes[0].body, { username: 'synthetic_trial', status: 'ACTIVE', trafficLimitBytes: 16 * 1024 ** 3, trafficLimitStrategy: 'NO_RESET', expireAt: '2035-01-04T00:00:00.000Z', hwidDeviceLimit: 4, activeInternalSquads: [nodeUuid] });
    assert.equal(state.writes.length, 1);
    assert.equal(state.modelCalls(), 0);
});

test('normal creation completes all button steps and an uncertain creation blocks another proposal for that name', async t => {
    const state = fixture(t, { creationEnabled: true, failedWrite: true });
    await state.open(); await state.click('q:stats'); await state.click('q:users'); await state.click('anew'); await state.click('ncname:normal'); await state.click('ncsource:manual');
    await state.send('synthetic_created'); await state.click('ncd:30'); await state.click('ncl:100'); await state.click('ncs:MONTH'); await state.click('nch:5');
    await state.click('nctelegram'); await state.click('nctginput');
    assert.match((await state.send('12345678')).text, /Example group/);
    const pending = state.actions().find(action => action.startsWith('ac:')).slice(3);
    const second = await state.administration.prepareCreate(actor, { username: 'synthetic_created', days: 3, trafficLimitBytes: 0, trafficLimitStrategy: 'NO_RESET', hwidDeviceLimit: 4, activeInternalSquads: [nodeUuid] });
    await state.click('ac:');
    assert.equal(state.administration.receipt(actor, pending), 'uncertain');
    assert.equal(state.writes.length, 1);
    await assert.rejects(state.administration.prepareCreate(actor, { username: 'synthetic_created', days: 3, trafficLimitBytes: 0, trafficLimitStrategy: 'NO_RESET', hwidDeviceLimit: 4, activeInternalSquads: [nodeUuid] }), /ADMIN_CREATE_UNCERTAIN/);
    await assert.rejects(state.administration.confirm(actor, second.id), /ADMIN_CONFIRMATION_EXPIRED/);
    assert.equal(state.writes.length, 1);
});

test('an unchanged success response cannot be presented as a confirmed renewal or retried', async t => {
    const state = fixture(t, { unchangedWrite: true });
    await state.send('продли 48 на 1 месяц');
    const pending = state.actions().find(action => action.startsWith('ac:')).slice(3);
    assert.match((await state.click('ac:')).text, /Операция недоступна/);
    assert.equal(state.administration.receipt(actor, pending), 'uncertain');
    assert.equal(state.writes.length, 1);
    await assert.rejects(state.administration.confirm(actor, pending), /ADMIN_CONFIRMATION_EXPIRED/);
});

test('creation requires configured groups and traffic defaults; typed fields never become executable settings', () => {
    assert.throws(() => validateExtensionConfiguration('ADMIN_CREATE_ENABLED=true'));
    assert.equal(validateExtensionConfiguration('').createOptions.enabled, false);
    assert.equal(validateExtensionConfiguration('').destructiveUserActions, false);
    const configured = `ADMIN_USER_READ_ENABLED=true\nADMIN_WRITE_ENABLED=true\nADMIN_CREATE_ENABLED=true\nADMIN_CREATE_SQUADS=${nodeUuid}\nADMIN_CREATE_DEFAULT_GB=16\n`;
    const policy = validateExtensionConfiguration(configured);
    assert.equal(policy.createOptions.trafficLimitBytes, 16 * 1024 ** 3);
    assert.equal(policy.createOptions.hwidLimit, 4);
    assert.throws(() => validateExtensionConfiguration(configured + 'ADMIN_CREATE_TRAFFIC_STRATEGY=UNKNOWN'));
});

test('subscription buttons require their explicit transport capability and reject mixed or unsafe actions', async () => {
    let requests = 0;
    const api = createTelegramApi({ token: '123456789:' + 'A'.repeat(35), allowedUserId: actor, enableButtons: true, enableSubscriptionButtons: true, fetchImpl: async () => { requests++; return Response.json({ ok: true, result: true }); } });
    const send = button => api.sendReply({ chat_id: actor, text: 'Подписка', protect_content: true, reply_markup: { inline_keyboard: [[button]] } });
    await send({ text: 'Открыть', url });
    await send({ text: 'Копировать', copy_text: { text: url } });
    for (const button of [
        { text: 'Ошибка', url: 'javascript:alert(1)' },
        { text: 'Ошибка', url: 'https://name:password@example.invalid/' },
        { text: 'Ошибка', url, callback_data: 'home' },
        { text: 'Ошибка', copy_text: { text: url, extra: true } },
        { text: 'Ошибка', copy_text: { text: 'https://example.invalid/' + 'a'.repeat(256) } },
    ]) await assert.rejects(send(button), /REPLY_BLOCKED/);
    assert.equal(requests, 2);
});

test('profile names are transliterated into the real panel schema with configurable affixes and deterministic bounds', () => {
    const policy = { prefix: 'chat_', suffix: '_demo', telegramNameSource: 'profile' };
    const identity = { id: 76543210, firstName: 'Иван', lastName: 'Петров', username: 'different_handle' };
    assert.equal(panelUsername(telegramName(identity, policy), policy), 'chat_ivan_petrov_demo');
    assert.equal(panelUsername('manual_name', policy), 'chat_manual_name_demo');
    assert.throws(() => panelUsername('wrong name', policy), /ADMIN_INVALID_USERNAME/);
    assert.throws(() => panelUsername('a'.repeat(36), policy), /ADMIN_INVALID_USERNAME/);
    const long = telegramName({ ...identity, firstName: 'ОченьДлинноеИмя'.repeat(8) }, policy);
    assert.equal(panelUsername(long, policy).length, 36);
    assert.equal(long, telegramName({ ...identity, firstName: 'ОченьДлинноеИмя'.repeat(8) }, policy));
    assert.equal(telegramName({ id: 76543210, firstName: '🐈' }, policy), 'id76543210');
    assert.equal(forwardedIdentity({ forward_origin: { type: 'hidden_user', sender_user_name: 'Private person' } }), null);
    assert.equal(forwardedIdentity({ forward_origin: { type: 'user', sender_user: { id: 76543210, first_name: 'Bot', is_bot: true } } }), null);
});

test('a trusted forwarded profile fills the new username and binds its actual Telegram ID without using forwarded text', async t => {
    const state = fixture(t, { creationEnabled: true, naming: { prefix: 'chat_', suffix: '_demo', telegramNameSource: 'profile', squads: [], squadNames: ['Example group'], strategy: 'DAY' } });
    const origin = { type: 'user', date: start / 1000, sender_user: { id: 76543210, is_bot: false, first_name: 'Иван', last_name: 'Петров', username: 'some_other_handle' } };
    await state.open();
    await state.forward(origin, 'отключи 48');
    assert.equal(state.writes.length, 0);
    await state.click('q:stats'); await state.click('q:users'); await state.click('anew'); await state.click('ncname:trial'); await state.click('ncsource:telegram');
    await state.forward(origin, 'отключи 48', actor + 1);
    assert.equal(state.writes.length, 0);
    assert.match((await state.forward(origin, 'отключи 48')).text, /chat_ivan_petrov_demo/);
    await state.click('ac:');
    assert.equal(state.writes.length, 1);
    assert.equal(state.writes[0].body.username, 'chat_ivan_petrov_demo');
    assert.equal(state.writes[0].body.telegramId, 76543210);
    assert.equal(state.writes[0].body.trafficLimitBytes, 16 * 1024 ** 3);
    assert.equal(state.writes[0].body.trafficLimitStrategy, 'DAY');
    assert.equal(state.writes[0].body.hwidDeviceLimit, 4);
    assert.deepEqual(state.writes[0].body.activeInternalSquads, [nodeUuid]);
    assert.equal(state.modelCalls(), 0);
});

test('hidden forwarded senders cannot bind the administrator or submit a name as a command', async t => {
    const state = fixture(t, { creationEnabled: true, naming: { prefix: 'chat_', suffix: '_demo' } });
    await state.open(); await state.click('q:stats'); await state.click('q:users'); await state.click('anew'); await state.click('ncname:trial'); await state.click('ncsource:telegram');
    assert.match((await state.forward({ type: 'hidden_user', sender_user_name: 'Hidden' }, 'продли 48 на 30 дней')).text, /скрыл/);
    assert.equal(state.writes.length, 0);
    await state.click('ncsource:manual');
    assert.match((await state.send('manual_user')).text, /chat_manual_user_demo/);
    await state.click('ac:');
    assert.equal(state.writes[0].body.telegramId, undefined);
    assert.equal(state.modelCalls(), 0);
});

test('squad editing adds and removes only the selected user memberships after a fresh confirmation', async t => {
    const state = fixture(t, { squadEdit: true });
    await state.send('пользователь 48'); await state.click('ags:48'); await state.click('agi:0');
    await state.click('agt:0'); assert.equal(state.writes.length, 0);
    assert.match((await state.click('agisave')).text, /Example group/);
    await state.click('ac:');
    assert.deepEqual(state.user.activeInternalSquads, state.internalGroups);
    assert.deepEqual(state.writes[0].body, { id: 48, activeInternalSquads: [nodeUuid] });
    await state.click('ags:48'); await state.click('age:0'); await state.click('aget:0'); await state.click('agesave'); await state.click('ac:');
    assert.equal(state.user.externalSquadUuid, state.externalGroups[0].uuid);
    await state.click('ags:48'); await state.click('agi:0'); await state.click('agt:0');
    assert.match((await state.click('agisave')).text, /доступ к нодам прекратится/);
    await state.click('ac:');
    assert.deepEqual(state.user.activeInternalSquads, []);
    await state.click('ags:48'); await state.click('age:0'); await state.click('ageclear'); await state.click('agesave'); await state.click('ac:');
    assert.equal(state.user.externalSquadUuid, null);
    assert.equal(state.writes.length, 4);
    assert.ok(state.writes.every(write => write.path === '/api/users/' && write.body.id === 48));
    assert.equal(state.modelCalls(), 0);
});

test('squad editing detects panel changes before preview and cannot bypass the target or feature policy', async t => {
    const state = fixture(t, { squadEdit: true });
    await state.send('пользователь 48'); await state.click('ags:48'); await state.click('agi:0'); await state.click('agt:0');
    state.user.externalSquadUuid = state.externalGroups[0].uuid;
    assert.match((await state.click('agisave')).text, /изменились/);
    assert.equal(state.writes.length, 0);
    const view = await state.administration.squadView(actor, '48');
    await assert.rejects(state.administration.prepareSquads(actor, '49', { activeInternalSquads: [nodeUuid] }, view.baseline), /ADMIN_ACTION_DISABLED/);
});

test('an uncertain squad write is not repeated and rejects memberships changed after preview', async t => {
    const state = fixture(t, { squadEdit: true, failedWrite: true });
    const view = await state.administration.squadView(actor, '48');
    const ticket = await state.administration.prepareSquads(actor, '48', { activeInternalSquads: [nodeUuid] }, view.baseline);
    await assert.rejects(state.administration.confirm(actor, ticket.id));
    assert.equal(state.administration.receipt(actor, ticket.id), 'uncertain');
    await assert.rejects(state.administration.confirm(actor, ticket.id), /ADMIN_CONFIRMATION_EXPIRED/);
    assert.equal(state.writes.length, 1);
    const second = await state.administration.prepareSquads(actor, '48', { activeInternalSquads: [nodeUuid] }, view.baseline);
    state.user.externalSquadUuid = state.externalGroups[0].uuid;
    await assert.rejects(state.administration.confirm(actor, second.id), /ADMIN_STALE/);
    assert.equal(state.writes.length, 1);
});
