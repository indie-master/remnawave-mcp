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
        assert.equal((await call('/api/payments', { currency: 'RUB', amount: '1', account: second }, headers)).status, 400);
        assert.equal((await call('/api/subscription', undefined, headers)).status, 200);
        assert.equal((await call('/api/account', undefined, { ...headers, Host: 'attacker.invalid' })).status, 400);
        assert.equal((await call('/api/logout', {}, { ...headers, Origin: 'https://attacker.invalid' })).status, 400);
        await call('/api/logout', {}, headers); assert.equal((await call('/api/account', undefined, headers)).status, 401);
    } finally { portal.closeAllConnections(); await new Promise(resolve => portal.close(resolve)); store.close(); }
});
