import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createBusinessStore } from './store.mjs';
import { createSupportAdministration } from './support-admin.mjs';

test('private support HTTP boundary validates message receipts and stale closure without changing billing', async () => {
    const store = createBusinessStore({ filename: ':memory:' });
    const first = store.provision('first@example.invalid', 'synthetic-password-only', 48).id;
    const second = store.provision('second@example.invalid', 'synthetic-password-only', 49).id;
    store.append(first, 'user', 'Вопрос'); const id = store.handoff(first);
    const handler = createSupportAdministration({ store });
    const server = createServer(async (incoming, outgoing) => { if (!await handler(incoming, outgoing)) outgoing.writeHead(404).end('{}'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const call = (path, body, contentType = 'application/json') => new Promise((resolve, reject) => {
        const outgoing = request({ host: '127.0.0.1', port: server.address().port, path, method: body === undefined ? 'GET' : 'POST', agent: false, headers: { 'Content-Type': contentType } }, incoming => {
            let text = ''; incoming.on('data', chunk => { text += chunk; }); incoming.on('end', () => resolve({ status: incoming.statusCode, data: JSON.parse(text) }));
        }); outgoing.on('error', reject); outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
    try {
        const original = await call('/support/' + id); assert.equal(original.data.panelId, 48);
        const value = { id, key: 'a'.repeat(32), text: 'Ответ администратора' };
        assert.equal((await call('/support-message', value)).status, 200);
        assert.equal((await call('/support-message', value)).data.replayed, true);
        assert.equal(store.supportHistory(first).length, 2); assert.deepEqual(store.supportHistory(second), []);
        for (const body of [{ ...value, account: second }, { ...value, text: 'Другая нагрузка' }, { ...value, key: 'invalid' }, null, []]) assert.equal((await call('/support-message', body)).status, 400);
        assert.equal((await call('/support-message', { ...value, key: 'b'.repeat(32) }, 'text/plain')).status, 400);
        assert.equal((await call('/support-message')).status, 400);
        assert.equal((await call('/support-close', { id, version: original.data.version })).status, 400);
        const latest = await call('/support/' + id);
        assert.equal((await call('/support-close', { id, version: latest.data.version })).data.closed, true);
        assert.equal((await call('/support-message', { ...value, key: 'c'.repeat(32) })).status, 400);
        const another = store.handoff(first);
        assert.equal((await call('/support-reply', { id: another, text: 'Старый формат совместим' })).status, 200);
        assert.equal(store.openSupport(first), undefined);
        assert.deepEqual(store.account(first).balances, { RUB: 0, USDT: 0 });
        assert.deepEqual(store.pendingPayments(), []); assert.deepEqual(store.pendingRenewals(), []);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); }
});
