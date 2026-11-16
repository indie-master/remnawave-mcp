import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createBusinessStore } from '../business/store.mjs';
import { createCustomerGateway } from '../business/customer-api.mjs';
import { createCustomerClient } from './gateway-client.mjs';
import { runCustomerBot } from './receiver.mjs';

test('real customer adapter reaches identity registration and Telegram-first signup through the actual gateway', async () => {
    const time = Date.parse('2026-11-16T12:00:00Z'); const id = 111111111; const botId = 999999999;
    const store = createBusinessStore({ filename: ':memory:', customerEnabled: true, now: () => time });
    const username = 'example_customer_bot';
    const server = createServer(createCustomerGateway({ store, username, miniAppUrl: 'https://portal.example.invalid/miniapp' }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const routes = []; const sent = []; const menu = []; const controller = new AbortController(); let polls = 0;
    const call = createCustomerClient({ requestImpl: (options, callback) => { routes.push(options.path); return request({ ...options, socketPath: undefined, host: '127.0.0.1', port: server.address().port }, callback); } });
    try {
        const result = await runCustomerBot({ call, config: { enabled: true, username, adminUsername: 'example_admin_bot' }, now: () => time, sleep: async () => {}, signal: controller.signal, api: {
            getMe: async () => ({ id: botId, username, is_bot: true }), getWebhookInfo: async () => ({ url: '' }), setMiniAppMenu: async url => menu.push(url),
            getUpdates: async () => { if (polls++) { controller.abort(); return []; } return [{ update_id: 1, message: { message_id: 1, date: time / 1000, text: '/start', from: { id, is_bot: false, first_name: 'Тест' }, chat: { id, type: 'private' } } }]; },
            send: async (recipient, text, keyboard) => { sent.push({ recipient, text, keyboard }); return { message_id: 1, chat: { id: recipient } }; },
        } });
        assert.equal(result.status, 'stopped'); assert.equal(store.customer.botIdentity(username), botId);
        assert.equal(store.customer.account(id).email, null);
        assert.ok(routes.includes('/identity')); assert.ok(routes.includes('/bootstrap')); assert.equal(sent[0].recipient, id);
        assert.equal(menu[0], 'https://portal.example.invalid/miniapp');
        assert.equal(sent[0].keyboard.inline_keyboard[0][0].web_app.url, menu[0]);
        let requested = false;
        await assert.rejects(createCustomerClient({ requestImpl: () => { requested = true; } })('/admin/delete', {}), /CUSTOMER_UNAVAILABLE/);
        assert.equal(requested, false);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); }
});

test('customer startup and polling survive extended network loss while a failed menu setup never blocks reception', async () => {
    const controller = new AbortController(); const events = []; const beats = []; const delays = []; let starts = 0; let polls = 0; let menu = 0;
    const network = () => Object.assign(new Error('PRIVATE_SOURCE_MUST_NOT_LEAK'), { code: 'NETWORK_FAILED' });
    const result = await runCustomerBot({ config: { enabled: true, username: 'example_customer_bot', adminUsername: 'example_admin_bot' }, signal: controller.signal,
        sleep: async value => delays.push(value), heartbeat: phase => beats.push(phase), onEvent: value => events.push(value),
        call: async path => path === '/ready' ? { ready: true, botUsername: 'example_customer_bot', miniAppUrl: 'https://portal.example.invalid/miniapp' } : {},
        api: { getMe: async () => { if (starts++ < 8) throw network(); return { id: 999999999, username: 'example_customer_bot', is_bot: true }; }, getWebhookInfo: async () => ({ url: '' }), setMiniAppMenu: async () => { menu++; throw network(); }, getUpdates: async () => { if (polls++ < 9) throw network(); controller.abort(); return []; } },
    });
    assert.equal(result.status, 'stopped'); assert.equal(starts, 9); assert.equal(polls, 10); assert.equal(menu, 1);
    assert.ok(beats.includes('reconnecting')); assert.ok(delays.every(value => value > 0 && value <= 30000));
    assert.ok(events.some(value => value.event === 'menu_setup')); assert.ok(!JSON.stringify(events).includes('PRIVATE_SOURCE'));
});
