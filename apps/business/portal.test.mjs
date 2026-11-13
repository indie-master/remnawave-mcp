import test from 'node:test';
import assert from 'node:assert/strict';
import { createBusinessStore, createSupport } from './store.mjs';
import { createPortal } from './portal.mjs';
import { request } from 'node:http';

test('portal login/CSRF/Host/account isolation and payment workflow use only synthetic local HTTP', async () => {
    const store = createBusinessStore({ filename: ':memory:' });
    const first = store.provision('first@example.invalid', 'synthetic-password-only', 1).id;
    const second = store.provision('second@example.invalid', 'synthetic-password-only', 2).id;
    const origin = 'http://localhost:8787';
    const portal = createPortal({ store, support: createSupport({ store }), origin, billingEnabled: true, panelRead: async id => ({ id, status: 'ACTIVE', expireAt: '2026-12-01T00:00:00Z', observedAt: '2026-10-16T12:00:00Z' }) });
    await new Promise(resolve => portal.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${portal.address().port}`;
    const call = (path, body, headers = {}) => new Promise((resolve, reject) => {
        const outgoing = request(base + path, { method: body === undefined ? 'GET' : 'POST', agent: false, headers: { Host: 'localhost:8787', Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } }, incoming => {
            let text = ''; incoming.on('data', chunk => { text += chunk; });
            incoming.on('end', () => resolve(new Response(text, { status: incoming.statusCode, headers: Object.fromEntries(Object.entries(incoming.headers).map(([name, value]) => [name, Array.isArray(value) ? value[0] : value])) })));
        }); outgoing.on('error', reject); outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
    try {
        const page = await call('/'); assert.equal(page.status, 200); assert.ok(page.headers.get('content-security-policy').includes("default-src 'none'"));
        assert.equal((await call('/api/account')).status, 401);
        const login = await call('/api/login', { email: 'first@example.invalid', password: 'synthetic-password-only' });
        const cookie = login.headers.get('set-cookie').split(';')[0]; const csrf = (await login.json()).csrf;
        assert.ok(login.headers.get('set-cookie').includes('HttpOnly')); assert.ok(login.headers.get('set-cookie').includes('SameSite=Strict'));
        const headers = { Cookie: cookie, 'X-CSRF-Token': csrf };
        assert.equal((await call('/api/account', undefined, headers)).status, 200);
        assert.equal((await call('/api/payments', { currency: 'RUB', amount: '123.45' }, { Cookie: cookie })).status, 400);
        const payment = await (await call('/api/payments', { currency: 'RUB', amount: '123.45' }, headers)).json();
        assert.equal(store.account(first).balances.RUB, 0); store.approvePayment(payment.id, 'test:receipt1'); assert.equal(store.account(first).balances.RUB, 12345);
        assert.equal(store.account(second).balances.RUB, 0);
        const renewal = store.requestRenewal(first, 'RUB', { units: 1000, days: 30 });
        const accountResponse = await (await call('/api/account', undefined, headers)).json();
        assert.equal(accountResponse.renewals[0].id, renewal.id);
        assert.equal(accountResponse.renewals[0].state, 'pending');
        assert.ok(!JSON.stringify(accountResponse.renewals).includes('proposal'));
        const otherLogin = await call('/api/login', { email: 'second@example.invalid', password: 'synthetic-password-only' });
        const otherCookie = otherLogin.headers.get('set-cookie').split(';')[0];
        assert.deepEqual((await (await call('/api/account', undefined, { Cookie: otherCookie })).json()).renewals, []);
        store.append(first, 'assistant', 'Ответ только первому аккаунту');
        const privateChat = await (await call('/api/support', undefined, headers)).json();
        assert.equal(privateChat.history.at(-1).text, 'Ответ только первому аккаунту');
        assert.deepEqual((await (await call('/api/support', undefined, { Cookie: otherCookie })).json()).history, []);
        assert.equal((await call('/api/support?account=' + first, undefined, { Cookie: otherCookie })).status, 404);
        assert.equal((await call('/recovery/' + renewal.id, undefined, headers)).status, 404);
        assert.equal((await call('/api/payments', { currency: 'RUB', amount: '1', account: second }, headers)).status, 400);
        assert.equal((await call('/api/subscription', undefined, headers)).status, 200);
        assert.equal((await call('/api/account', undefined, { ...headers, Host: 'attacker.invalid' })).status, 400);
        assert.equal((await call('/api/logout', {}, { ...headers, Origin: 'https://attacker.invalid' })).status, 400);
        await call('/api/logout', {}, headers); assert.equal((await call('/api/account', undefined, headers)).status, 401);
    } finally { portal.closeAllConnections(); await new Promise(resolve => portal.close(resolve)); store.close(); }
});

async function portalFixture({ customerEnabled = false, ...options } = {}) {
    const store = createBusinessStore({ filename: ':memory:', customerEnabled });
    const first = store.provision('pilot@example.invalid', 'synthetic-password-only', 48).id;
    const origin = 'http://localhost:8787';
    const server = createPortal({ store, origin, support: createSupport({ store }), ...options });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let cookie; let csrf;
    const close = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); };
    const call = (path, body, authorized = true, extraHeaders = {}) => new Promise((resolve, reject) => {
        const outgoing = request({ host: '127.0.0.1', port: server.address().port, path: '/api/' + path, method: body === undefined ? 'GET' : 'POST', agent: false, headers: { Host: 'localhost:8787', Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(authorized ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}), ...extraHeaders } }, incoming => {
            let text = ''; incoming.on('data', chunk => { text += chunk; });
            incoming.on('end', () => { try { resolve({ status: incoming.statusCode, data: JSON.parse(text), headers: incoming.headers }); } catch (error) { reject(error); } });
        }); outgoing.on('error', reject); outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
    try {
        const login = await call('login', { email: 'pilot@example.invalid', password: 'synthetic-password-only' }, false);
        assert.equal(login.status, 200); cookie = login.headers['set-cookie'][0].split(';')[0]; csrf = login.data.csrf;
        return { store, first, call, close };
    } catch (error) { await close(); throw error; }
}

test('closed portal pilot exposes enabled features only, isolates support, and cannot credit or renew', async () => {
    const pilot = await portalFixture({ plans: { RUB: { units: 12345, days: 30 } } });
    try {
        const account = await pilot.call('account');
        assert.deepEqual(account.data.features, { billing: false, media: false, panel: false });
        assert.deepEqual(account.data.plans, []);
        assert.equal((await pilot.call('payments', { currency: 'RUB', amount: '123.45' })).status, 404);
        assert.equal((await pilot.call('renewal', { currency: 'RUB' })).status, 404);
        assert.equal((await pilot.call('subscription')).data.code, 'PANEL_UNAVAILABLE');
        assert.equal((await pilot.call('support', { question: 'Неизвестная проблема подключения' })).data.source, 'human');
        assert.equal(pilot.store.pendingSupport().length, 1);
        assert.deepEqual(pilot.store.account(pilot.first).balances, { RUB: 0, USDT: 0 });
        assert.deepEqual(pilot.store.pendingPayments(), []); assert.deepEqual(pilot.store.renewals(pilot.first), []);
        assert.equal((await pilot.call('account', undefined, false)).status, 401);
    } finally { await pilot.close(); }
});

test('customer sees fixed RUB/USDT prices and changed or injected quotes cannot create renewal requests', async () => {
    const pilot = await portalFixture({ billingEnabled: true, plans: { RUB: { units: 12345, days: 30 }, USDT: { units: 2500000, days: 30 } }, panelRead: async id => ({ id }) });
    try {
        const account = await pilot.call('account');
        assert.equal(account.data.features.panel, true);
        assert.deepEqual(account.data.plans, [{ currency: 'RUB', units: 12345, days: 30 }, { currency: 'USDT', units: 2500000, days: 30 }]);
        const deposit = pilot.store.payment(pilot.first, 'RUB', 12345); pilot.store.approvePayment(deposit.id, 'test:pilot-rub');
        for (const body of [{ currency: 'RUB', units: 1, days: 30 }, { currency: 'RUB', units: 12345, days: 1 }, { currency: 'RUB', units: '12345', days: 30 }, { currency: 'USDT', units: 2500000, days: 31 }]) assert.equal((await pilot.call('renewal', body)).data.code, 'RENEWAL_PLAN_CHANGED');
        for (const body of [{ currency: 'RUB', days: 30 }, { currency: 'RUB', units: 12345, days: 30, account: 'other' }, { currency: '__proto__' }]) assert.equal((await pilot.call('renewal', body)).status, 400);
        assert.deepEqual(pilot.store.renewals(pilot.first), []);
        assert.equal((await pilot.call('renewal', account.data.plans[0])).status, 200);
        assert.equal(pilot.store.renewals(pilot.first)[0].state, 'pending');
        assert.equal(pilot.store.account(pilot.first).balances.RUB, 12345);
        assert.equal((await pilot.call('renewal', account.data.plans[0])).data.code, 'RENEWAL_PENDING');
    } finally { await pilot.close(); }
});

test('zero price remains unavailable and legacy currency-only renewal requests remain compatible', async () => {
    const pilot = await portalFixture({ billingEnabled: true, plans: { RUB: { units: 0, days: 30 }, USDT: { units: 1000000, days: 7 } } });
    try {
        assert.deepEqual((await pilot.call('account')).data.plans, [{ currency: 'USDT', units: 1000000, days: 7 }]);
        assert.equal((await pilot.call('renewal', { currency: 'RUB' })).data.code, 'RENEWAL_PLAN_UNAVAILABLE');
        const deposit = pilot.store.payment(pilot.first, 'USDT', 1000000); pilot.store.approvePayment(deposit.id, 'test:pilot-usdt');
        assert.equal((await pilot.call('renewal', { currency: 'USDT' })).status, 200);
        assert.equal(pilot.store.account(pilot.first).balances.USDT, 1000000);
    } finally { await pilot.close(); }
});

test('portal Telegram linking requires its own logged-in CSRF session and never accepts a supplied account or Telegram ID', async () => {
    const pilot = await portalFixture({ customerEnabled: true, customerUsername: 'example_customer_bot' });
    try {
        assert.equal((await pilot.call('telegram-link', {}, false)).status, 401);
        assert.equal((await pilot.call('telegram-link', {}, true, { 'X-CSRF-Token': 'wrong' })).status, 400);
        assert.equal((await pilot.call('telegram-link', { account: 'another' })).status, 400);
        assert.equal((await pilot.call('telegram-link', { telegramId: 111111111 })).status, 400);
        const response = await pilot.call('telegram-link', {}); assert.equal(response.status, 200);
        const url = new URL(response.data.url); assert.equal(url.origin, 'https://t.me'); assert.equal(url.pathname, '/example_customer_bot');
        const code = url.searchParams.get('start'); assert.match(code, /^[A-Za-z0-9_-]{32}$/);
        pilot.store.customer.link(111111111, code);
        const account = (await pilot.call('account')).data;
        assert.equal(account.telegram.linked, true); assert.ok(!JSON.stringify(account).includes(code));
        assert.equal((await pilot.call('support')).data.telegram.linked, true);
        assert.equal((await pilot.call('telegram-unlink', { account: 'another' })).status, 400);
        assert.equal((await pilot.call('telegram-unlink', {})).data.unlinked, true);
        assert.throws(() => pilot.store.customer.account(111111111), /NOT_LINKED/);
    } finally { await pilot.close(); }
});
