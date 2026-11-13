import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { request } from 'node:http';
import { createBusinessStore, createSupport } from './store.mjs';
import { createPortal } from './portal.mjs';
import { verifyTelegramLaunch } from './telegram-auth.mjs';
import { validateBusinessEnv } from './config.mjs';
import { createCustomerHandler } from '../customer-bot/handler.mjs';
import { createTelegramApi } from '../telegram-client/telegram-api.mjs';
import { createSupportInbox } from '../telegram-admin/support-inbox.mjs';

const now = () => Date.parse('2026-11-13T10:00:00Z'); const botId = 999999999;
const profile = { telegramId: 111111111, firstName: 'Тест', lastName: 'Клиент' };
const keys = generateKeyPairSync('ed25519');
function launch(user = profile, patch = {}, id = botId) {
    const fields = new URLSearchParams({ auth_date: String(now() / 1000), user: JSON.stringify({ id: user.telegramId, first_name: user.firstName, last_name: user.lastName }), query_id: 'synthetic_launch', ...patch });
    const check = id + ':WebAppData\n' + [...fields].sort(([a], [b]) => a < b ? -1 : 1).map(([key, value]) => key + '=' + value).join('\n');
    fields.set('signature', sign(null, Buffer.from(check), keys.privateKey).toString('base64url')); fields.set('hash', 'a'.repeat(64));
    return fields.toString();
}
const verified = data => verifyTelegramLaunch(data, botId, { now, publicKey: keys.publicKey });
const fixture = () => createBusinessStore({ filename: ':memory:', customerEnabled: true, now });

test('Mini App verifies the signed bot and user, expiry, duplicate parameters and tampering without a bot token', () => {
    const value = launch(); assert.deepEqual(verified(value).profile, profile);
    for (const data of [value.replace('synthetic_launch', 'tampered'), value + '&user=%7B%7D', launch(profile, { auth_date: String(now() / 1000 - 301) }), launch(profile, { auth_date: String(now() / 1000 + 16) }), launch(profile, {}, botId + 1), launch(profile, { user: '{"id":111111111,"first_name":"X","is_bot":true}' })]) assert.throws(() => verified(data), /LOGIN_REJECTED/);
    assert.throws(() => verifyTelegramLaunch(value, botId), /LOGIN_REJECTED/);
    assert.throws(() => verified('x'.repeat(4000)), /LOGIN_REJECTED/);
});

test('Telegram start creates one isolated account, no subscription, balance or automatic renewal', () => {
    const store = fixture();
    try {
        store.customer.ensure(profile); store.customer.ensure({ ...profile, firstName: 'Переименован' });
        const account = store.customer.account(profile.telegramId);
        assert.equal(account.email, null); assert.equal(account.panelId, null); assert.equal(account.profileName, 'Тест Клиент');
        assert.deepEqual(account.balances, { RUB: 0, USDT: 0 });
        assert.throws(() => store.customer.unlink(store.customer.webLogin(verified(launch())).accountId), /EMAIL_REQUIRED/);
        const session = store.customer.webLogin(verified(launch(profile, { query_id: 'different' })));
        assert.throws(() => store.requestRenewal(session.accountId, 'RUB', { units: 1, days: 30 }), /PANEL_UNAVAILABLE/);
        assert.deepEqual(store.pendingPayments(), []);
    } finally { store.close(); }
});

test('signup can be disabled while existing email-first bindings still work, and bootstrap never returns email or panel identifiers', () => {
    const store = createBusinessStore({ filename: ':memory:', now, customerEnabled: true, customerSignupEnabled: false });
    try {
        assert.throws(() => store.customer.ensure(profile), /NOT_LINKED/);
        const account = store.provision('existing@example.invalid', 'synthetic-password-only', 48).id;
        store.customer.link(profile.telegramId, store.customer.issue(account).code);
        assert.deepEqual(store.customer.ensure(profile), { ready: true });
        assert.equal(store.customer.account(profile.telegramId).panelId, 48);
    } finally { store.close(); }
});

test('Telegram login is single-use across browsers, resumable by its own session and revoked on unlink', () => {
    const store = fixture();
    try {
        const data = verified(launch()); const first = store.customer.webLogin(data);
        assert.throws(() => store.customer.webLogin(data), /LOGIN_REJECTED/);
        assert.equal(store.customer.webLogin(data, first.token).token, first.token);
        const resumed = verified(launch(profile, { query_id: 'resumed' }));
        assert.equal(store.customer.webLogin(resumed, first.token).token, first.token);
        assert.throws(() => store.customer.webLogin(resumed), /LOGIN_REJECTED/);
        const email = store.attachEmail(first.accountId, 'new@example.invalid', 'synthetic-password-only');
        assert.throws(() => store.session(first.token), /SESSION_EXPIRED/);
        const second = store.customer.webLogin(verified(launch(profile, { query_id: 'next' })));
        store.customer.unlink(first.accountId);
        assert.throws(() => store.session(second.token), /SESSION_EXPIRED/);
        assert.equal(store.session(email.token).account, first.accountId);
        assert.equal(store.login('new@example.invalid', 'synthetic-password-only', 'synthetic').accountId, first.accountId);
    } finally { store.close(); }
});

test('existing email credentials join a provisional Telegram account without losing the target balance or either transcript', () => {
    const store = fixture();
    try {
        const target = store.provision('existing@example.invalid', 'synthetic-password-only', 48).id;
        const payment = store.payment(target, 'RUB', 10000); store.approvePayment(payment.id, 'manual:synthetic_receipt');
        store.append(target, 'user', 'Старое обращение'); store.handoff(target);
        const initial = store.customer.webLogin(verified(launch()));
        store.customer.question(profile.telegramId, 'first', 'Новое обращение Telegram');
        assert.throws(() => store.connectEmail(initial.accountId, 'existing@example.invalid', 'wrong-password', 'local'), /LOGIN_FAILED/);
        assert.equal(store.customer.account(profile.telegramId).panelId, null);
        const next = store.connectEmail(initial.accountId, 'existing@example.invalid', 'synthetic-password-only', 'local');
        assert.equal(next.accountId, target); assert.equal(store.customer.account(profile.telegramId).panelId, 48);
        assert.equal(store.account(target).balances.RUB, 10000);
        assert.ok(JSON.stringify(store.supportHistory(target)).includes('Старое обращение')); assert.ok(JSON.stringify(store.supportHistory(target)).includes('Новое обращение'));
        assert.equal(store.pendingSupport().length, 1);
        assert.throws(() => store.session(initial.token), /SESSION_EXPIRED/);
        assert.throws(() => store.account(initial.accountId), /ACCOUNT_UNAVAILABLE/);
    } finally { store.close(); }
});

test('portal-first link can join a provisional Telegram account, but financial records or another binding prevent an implicit merge', () => {
    const store = fixture();
    try {
        const target = store.provision('existing@example.invalid', 'synthetic-password-only', 48).id;
        store.customer.ensure(profile); store.customer.question(profile.telegramId, 'question', 'Сохраните сообщение');
        store.customer.link(profile.telegramId, store.customer.issue(target).code);
        assert.equal(store.customer.account(profile.telegramId).panelId, 48); assert.match(JSON.stringify(store.supportHistory(target)), /Сохраните/);
        const otherProfile = { ...profile, telegramId: 222222222 };
        const other = store.customer.webLogin(verified(launch(otherProfile)));
        store.payment(other.accountId, 'RUB', 100);
        const free = store.provision('free@example.invalid', 'synthetic-password-only', 49).id;
        assert.throws(() => store.customer.link(otherProfile.telegramId, store.customer.issue(free).code), /MERGE_REQUIRES_ADMIN/);
        assert.equal(store.account(other.accountId).email, null); assert.equal(store.payments(other.accountId).length, 1);
        assert.throws(() => store.connectEmail(other.accountId, 'existing@example.invalid', 'synthetic-password-only', 'local'), /LINK_REJECTED/);
        assert.equal(store.customer.account(profile.telegramId).panelId, 48);
    } finally { store.close(); }
});

test('customer start and HTTPS Mini App buttons work without prior portal provisioning or administrative routes', async () => {
    const calls = []; const messages = [];
    const handle = createCustomerHandler({ botId, now, miniAppUrl: 'https://portal.example.invalid/miniapp', call: async (path, body) => { calls.push({ path, body }); return {}; }, send: async (id, text, keyboard) => messages.push({ id, text, keyboard }) });
    await handle({ update_id: 1, message: { message_id: 1, date: now() / 1000, text: '/start', from: { id: profile.telegramId, is_bot: false, first_name: profile.firstName, last_name: profile.lastName }, chat: { id: profile.telegramId, type: 'private' } } });
    assert.deepEqual(calls, [{ path: '/bootstrap', body: profile }]);
    assert.equal(messages[0].keyboard.inline_keyboard[0][0].web_app.url, 'https://portal.example.invalid/miniapp');
    assert.throws(() => createCustomerHandler({ miniAppUrl: 'http://localhost:8787/miniapp' }), /MINI_APP_URL/);
});

test('only the explicitly enabled customer transport accepts HTTPS Mini App controls and menu setup', async () => {
    const requests = []; const options = { token: '123456789:' + 'a'.repeat(35), allowedUserId: 111111111, enableButtons: true, fetchImpl: async (url, init) => { requests.push({ method: url.split('/').at(-1), body: JSON.parse(init.body) }); return new Response(JSON.stringify({ ok: true, result: true })); } };
    const url = 'https://portal.example.invalid/miniapp';
    const payload = { chat_id: 111111111, text: 'Кабинет', protect_content: true, reply_markup: { inline_keyboard: [[{ text: 'Кабинет', web_app: { url } }]] } };
    await assert.rejects(createTelegramApi(options).sendReply(payload), /REPLY_BLOCKED/);
    const customer = createTelegramApi({ ...options, enableMiniAppButtons: true });
    await customer.sendReply(payload); await customer.setMiniAppMenu(url);
    assert.equal(requests[1].method, 'setChatMenuButton');
    await assert.rejects(customer.setMiniAppMenu('https://portal.example.invalid/miniapp?token=x'), /REPLY_BLOCKED/);
    assert.equal(requests.length, 2);
});

test('administrators can reply natively to a new Telegram client without a panel user ID', async () => {
    const store = fixture();
    try {
        const session = store.customer.webLogin(verified(launch())); store.customer.question(profile.telegramId, 'first', 'Помогите подключиться');
        const ticket = store.openSupport(session.accountId);
        const inbox = createSupportInbox({ actorId: 123456789, now, call: async (path, body) => path.startsWith('/support/') ? store.supportThread(ticket) : store.supportMessage(body.id, body.key, body.text) });
        const opened = await inbox.handle({ allowedUserId: 123456789, data: 'bh:' + ticket });
        assert.match(opened.text, /клиент Telegram/);
        const response = await inbox.handle({ allowedUserId: 123456789, text: 'Ответ новому клиенту', updateId: 20 });
        assert.match(response.text, /Ответ/); assert.equal(store.customer.claim().delivery.telegramId, profile.telegramId);
    } finally { store.close(); }
});

test('Mini App flag requires an enabled customer bot and HTTPS origin', () => {
    const env = { PORTAL_PUBLIC_ORIGIN: 'https://portal.example.invalid', REMNAWAVE_BASE_URL: 'https://panel.example.invalid', CUSTOMER_BOT_ENABLED: 'true', CUSTOMER_BOT_USERNAME: 'example_customer_bot', PORTAL_MINI_APP_ENABLED: 'true' };
    assert.equal(validateBusinessEnv(env), true);
    assert.throws(() => validateBusinessEnv({ ...env, PORTAL_PUBLIC_ORIGIN: 'http://localhost:8787' }));
    assert.throws(() => validateBusinessEnv({ ...env, CUSTOMER_BOT_ENABLED: 'false' }));
});

test('Mini App HTTP exchanges a verified launch only, protects email changes and separates iframe policy from ordinary login', async () => {
    const store = fixture(); const origin = 'https://portal.example.invalid';
    store.customer.registerBot('example_customer_bot', botId);
    const portal = createPortal({ store, origin, customerUsername: 'example_customer_bot', miniAppEnabled: true, support: createSupport({ store }), verifyLaunch: (data, id) => { assert.equal(id, botId); return verified(data); } });
    await new Promise(resolve => portal.listen(0, '127.0.0.1', resolve));
    const call = (path, body, headers = {}) => new Promise((resolve, reject) => {
        const outgoing = request({ host: '127.0.0.1', port: portal.address().port, path, method: body ? 'POST' : 'GET', headers: { Host: 'portal.example.invalid', Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, incoming => { let text = ''; incoming.on('data', part => { text += part; }); incoming.on('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, text })); }); outgoing.on('error', reject); outgoing.end(body ? JSON.stringify(body) : undefined);
    });
    try {
        const root = await call('/'); const mini = await call('/miniapp');
        assert.equal(root.headers['x-frame-options'], 'DENY'); assert.equal(mini.headers['x-frame-options'], undefined);
        assert.ok(!root.text.includes('src="https://telegram.org/')); assert.ok(mini.text.includes('src="https://telegram.org/js/telegram-web-app.js"'));
        assert.match(mini.headers['content-security-policy'], /frame-ancestors.*web\.telegram\.org/);
        const data = launch();
        assert.equal((await call('/api/telegram-login', { initData: data }, { Origin: 'https://attacker.invalid' })).status, 400);
        const login = await call('/api/telegram-login', { initData: data }, { 'X-Portal-Mini-App': '1' }); assert.equal(login.status, 200);
        const cookie = login.headers['set-cookie'][0].split(';')[0]; const csrf = JSON.parse(login.text).csrf;
        const bearer = 'Bearer ' + JSON.parse(login.text).sessionKey;
        assert.equal((await call('/api/account', undefined, { Authorization: bearer })).status, 200);
        assert.equal((await call('/api/account', undefined, { Authorization: 'Bearer bad', Cookie: cookie })).status, 401);
        assert.ok(!JSON.parse((await call('/api/account', undefined, { Authorization: bearer })).text).sessionKey);
        assert.match(login.headers['set-cookie'][0], /HttpOnly; SameSite=None;.*Secure/);
        assert.equal((await call('/api/telegram-login', { initData: data })).status, 400);
        assert.equal((await call('/api/telegram-login', { initData: data }, { Cookie: cookie })).status, 200);
        assert.equal(JSON.parse((await call('/api/account', undefined, { Cookie: cookie })).text).email, null);
        assert.equal((await call('/api/email-credentials', { email: 'new@example.invalid', password: 'synthetic-password-only' }, { Cookie: cookie })).status, 400);
        const linked = await call('/api/email-credentials', { email: 'new@example.invalid', password: 'synthetic-password-only' }, { Cookie: cookie, 'X-CSRF-Token': csrf });
        assert.equal(linked.status, 200); assert.ok(!linked.text.includes('synthetic-password-only'));
        assert.equal((await call('/api/account', undefined, { Cookie: cookie })).status, 401);
        assert.equal((await call('/api/account', undefined, { Authorization: bearer })).status, 401);
    } finally { portal.closeAllConnections(); await new Promise(resolve => portal.close(resolve)); store.close(); }
});
