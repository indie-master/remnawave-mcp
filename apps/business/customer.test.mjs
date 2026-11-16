import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createBusinessStore } from './store.mjs';
import { createCustomerGateway } from './customer-api.mjs';

function fixture() {
    let time = Date.parse('2026-11-13T10:00:00Z');
    const store = createBusinessStore({ filename: ':memory:', customerEnabled: true, now: () => time });
    const first = store.provision('first@example.invalid', 'synthetic-password-only', 48).id;
    const second = store.provision('second@example.invalid', 'synthetic-password-only', 49).id;
    return { store, first, second, advance: milliseconds => { time += milliseconds; } };
}

test('customer link codes require account possession, are single-use and do not allow rebinding by a known ID', () => {
    const { store, first, second, advance } = fixture();
    try {
        const old = store.customer.issue(first); const fresh = store.customer.issue(first);
        assert.throws(() => store.customer.link(111111111, old.code));
        assert.equal(store.customer.link(111111111, fresh.code).linked, true);
        assert.throws(() => store.customer.link(222222222, fresh.code));
        assert.throws(() => store.customer.issue(first), /ALREADY_LINKED/);
        const other = store.customer.issue(second);
        assert.throws(() => store.customer.link(111111111, other.code));
        assert.equal(store.customer.account(111111111).panelId, 48);
        advance(300001); assert.throws(() => store.customer.link(222222222, other.code));
        const next = store.customer.issue(second); store.customer.link(222222222, next.code);
        assert.equal(store.customer.account(222222222).panelId, 49);
        store.customer.unlink(first); assert.throws(() => store.customer.account(111111111), /NOT_LINKED/);
        assert.equal(store.customer.account(222222222).panelId, 49);
    } finally { store.close(); }
});

test('customer support and native admin responses share only the linked account history and outbox', () => {
    const { store, first, second } = fixture();
    try {
        store.customer.link(111111111, store.customer.issue(first).code);
        store.customer.link(222222222, store.customer.issue(second).code);
        const question = store.customer.question(111111111, 'update_1', 'Нужна помощь с подключением');
        assert.equal(question.source, 'human');
        assert.equal(store.customer.question(111111111, 'update_1', 'Нужна помощь с подключением').replayed, true);
        assert.throws(() => store.customer.question(222222222, 'update_1', 'Нужна помощь с подключением'));
        store.customer.question(111111111, 'update_2', 'Дополнительное уточнение');
        assert.equal(store.supportHistory(first).filter(item => item.role === 'assistant').length, 1);
        assert.deepEqual(store.customer.history(222222222), []);
        const ticket = store.openSupport(first);
        store.supportMessage(ticket, 'a'.repeat(32), 'Ответ первого клиента');
        store.supportMessage(ticket, 'a'.repeat(32), 'Ответ первого клиента');
        const delivery = store.customer.claim().delivery;
        assert.equal(delivery.telegramId, 111111111); assert.equal(delivery.text, 'Ответ первого клиента');
        store.customer.settle(delivery.id, delivery.lease, 'done');
        assert.equal(store.customer.claim().delivery, null);
        assert.equal(store.customer.history(111111111).at(-1).text, 'Ответ первого клиента');
        assert.deepEqual(store.customer.history(222222222), []);
        assert.deepEqual(store.account(first).balances, { RUB: 0, USDT: 0 });
    } finally { store.close(); }
});

test('unknown delivery never automatically repeats, unlink cancels pending delivery, and reused row IDs do not lose new replies', () => {
    const { store, first } = fixture();
    try {
        store.customer.link(111111111, store.customer.issue(first).code);
        store.append(first, 'user', 'Вопрос'); const ticket = store.handoff(first);
        store.supportMessage(ticket, 'a'.repeat(32), 'Первый ответ');
        const firstDelivery = store.customer.claim().delivery;
        assert.equal(store.customer.claim().delivery, null);
        assert.throws(() => store.customer.settle(firstDelivery.id, firstDelivery.lease, 'done'));
        store.eraseHistory(first); store.supportMessage(ticket, 'b'.repeat(32), 'Новый ответ после очистки истории');
        assert.equal(store.customer.claim().delivery.text, 'Новый ответ после очистки истории');
        store.supportMessage(ticket, 'c'.repeat(32), 'Отменённый ответ');
        store.customer.unlink(first); assert.equal(store.customer.claim().delivery, null);
        store.customer.link(111111111, store.customer.issue(first).code);
        assert.equal(store.customer.claim().delivery, null);
    } finally { store.close(); }
});

test('link attempts and incoming questions are bounded and disabled mode cannot link or deliver', () => {
    const { store, first } = fixture();
    try {
        for (let index = 0; index < 5; index++) assert.throws(() => store.customer.link(111111111, 'x'.repeat(32)));
        assert.throws(() => store.customer.link(111111111, store.customer.issue(first).code), /RATE_LIMIT/);
        store.customer.link(222222222, store.customer.issue(first).code);
        for (let index = 0; index < 10; index++) store.customer.question(222222222, 'update_' + index, 'Уточнение ' + index);
        assert.throws(() => store.customer.question(222222222, 'extra', 'Ещё сообщение'), /RATE_LIMIT/);
        const disabled = createBusinessStore({ filename: ':memory:' });
        try { assert.throws(() => disabled.customer.claim(), /DISABLED/); assert.throws(() => disabled.customer.link(111111111, 'x'.repeat(32)), /DISABLED/); } finally { disabled.close(); }
    } finally { store.close(); }
});

test('customer IPC rejects administrative routes and supplied account IDs before reading the panel', async () => {
    const { store, first, second } = fixture(); let panelCalls = 0;
    store.customer.link(111111111, store.customer.issue(first).code); store.customer.link(222222222, store.customer.issue(second).code);
    const server = createServer(createCustomerGateway({ store, username: 'example_customer_bot', panelRead: async id => { panelCalls++; return { status: 'ACTIVE', expireAt: '2026-12-01T00:00:00Z', observedAt: '2026-11-13T10:00:00Z', testId: id }; } }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const call = async (path, body) => { const response = await fetch(`http://127.0.0.1:${server.address().port}` + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: response.status, data: await response.json() }; };
    try {
        for (const path of ['/approve', '/support-message', '/nodes', '/renewal-settle']) assert.equal((await call(path, { telegramId: 111111111 })).status, 400);
        assert.equal((await call('/account', { telegramId: 111111111, account: second })).status, 400);
        assert.equal((await call('/history', { telegramId: 111111111, panelId: 49 })).status, 400);
        assert.equal(panelCalls, 0);
        const account = await call('/account', { telegramId: 111111111 }); assert.equal(account.data.subscription.testId, 48);
        assert.equal(account.data.email, undefined); assert.equal(account.data.panelId, undefined);
        assert.equal((await call('/account', { telegramId: 333333333 })).data.code, 'CUSTOMER_NOT_LINKED');
        assert.equal(panelCalls, 1);
        await call('/question', { telegramId: 111111111, key: 'test_update', text: 'Личная переписка первого' });
        assert.deepEqual((await call('/history', { telegramId: 222222222 })).data.history, []);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); }
});
