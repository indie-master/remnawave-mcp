import test from 'node:test';
import assert from 'node:assert/strict';
import { createBusinessStore } from '../business/store.mjs';
import { createCustomerHandler } from './handler.mjs';
import { runCustomerBot } from './receiver.mjs';
import { readCustomerConfig, validateCustomerSettings } from './config.mjs';

const time = Date.parse('2026-11-13T10:00:00Z'); const botId = 999999999;
const config = { enabled: true, username: 'example_customer_bot', adminUsername: 'example_admin_bot' };
function fixture() {
    const store = createBusinessStore({ filename: ':memory:', customerEnabled: true, now: () => time });
    const first = store.provision('first@example.invalid', 'synthetic-password-only', 48).id;
    const second = store.provision('second@example.invalid', 'synthetic-password-only', 49).id;
    store.customer.link(111111111, store.customer.issue(first).code); store.customer.link(222222222, store.customer.issue(second).code);
    const calls = []; const sent = []; const edited = [];
    const call = async (path, value) => {
        calls.push({ path, value });
        if (path === '/ready') return { ready: true, botUsername: config.username };
        if (path === '/identity') return store.customer.registerBot(value.username, value.botId);
        if (path === '/bootstrap') return store.customer.ensure(value);
        if (path === '/account') return store.customer.account(value.telegramId);
        if (path === '/history') return { history: store.customer.history(value.telegramId) };
        if (path === '/question') return store.customer.question(value.telegramId, value.key, value.text);
        if (path === '/link') return store.customer.link(value.telegramId, value.code);
        if (path === '/deliveries/claim') return store.customer.claim();
        if (path === '/deliveries/settle') return store.customer.settle(value.id, value.lease, value.outcome);
        throw new Error('UNEXPECTED_ROUTE');
    };
    const send = async (id, text) => { sent.push({ id, text }); return { message_id: sent.length, chat: { id } }; };
    const edit = async (id, messageId, text) => { edited.push({ id, messageId, text }); return { message_id: messageId, chat: { id } }; };
    const handle = createCustomerHandler({ call, send, edit, answerCallback: async () => {}, botId, now: () => time });
    let sequence = 0;
    const message = (id, text, patch = {}) => ({ update_id: ++sequence, message: { message_id: sequence, date: time / 1000, from: { id, is_bot: false }, chat: { id, type: 'private' }, text, ...patch } });
    const callback = (id, data, patch = {}) => ({ update_id: ++sequence, callback_query: { id: 'cb' + sequence, data, from: { id, is_bot: false }, message: { message_id: 15, from: { id: botId, is_bot: true }, chat: { id, type: 'private' }, ...patch } } });
    return { store, first, second, calls, sent, edited, call, send, handle, message, callback };
}

test('customer configuration is opt-in and never permits the administrative bot identity', () => {
    assert.equal(validateCustomerSettings({ CUSTOMER_BOT_ENABLED: 'false', CUSTOMER_BOT_USERNAME: config.username }).enabled, false);
    assert.equal(validateCustomerSettings({ CUSTOMER_BOT_ENABLED: 'false', CUSTOMER_BOT_USERNAME: 'a_bot' }).username, 'a_bot');
    assert.throws(() => validateCustomerSettings({ CUSTOMER_BOT_ENABLED: 'false', CUSTOMER_BOT_USERNAME: 'a'.repeat(30) + 'bot' }));
    assert.throws(() => readCustomerConfig({ CUSTOMER_BOT_ENABLED: 'false', CUSTOMER_BOT_USERNAME: config.username, ADMIN_BOT_USERNAME: config.adminUsername }));
    assert.throws(() => readCustomerConfig({ CUSTOMER_BOT_ENABLED: 'true', CUSTOMER_BOT_USERNAME: config.adminUsername, ADMIN_BOT_USERNAME: config.adminUsername.toUpperCase() }));
    assert.equal(readCustomerConfig({ CUSTOMER_BOT_ENABLED: 'true', CUSTOMER_BOT_USERNAME: config.username, ADMIN_BOT_USERNAME: config.adminUsername }).tokenFile, '/run/secrets/customer_telegram_token');
});

test('customer messages use only their linked history and do not repeat handoff prompts or expose admin commands', async () => {
    const state = fixture();
    try {
        await state.handle(state.message(111111111, 'Неизвестная проблема первого'));
        await state.handle(state.message(111111111, 'Уточнение первого'));
        assert.equal(state.sent.length, 1);
        await state.handle(state.message(222222222, 'Проблема второго'));
        assert.ok(!JSON.stringify(state.store.customer.history(222222222)).includes('первого'));
        await state.handle(state.callback(111111111, 'customer_history'));
        assert.equal(state.edited.at(-1).id, 111111111); assert.equal(state.edited.at(-1).messageId, 15);
        const before = state.calls.length;
        await state.handle(state.message(111111111, '/approve anything'));
        await state.handle(state.callback(111111111, 'admin_home'));
        assert.equal(state.calls.length, before);
        assert.ok(!state.calls.some(item => /approve|nodes|renewal/.test(item.path)));
    } finally { state.store.close(); }
});

test('customer groups, forwards, stale messages and foreign bot callbacks cannot reach storage or delivery', async () => {
    const state = fixture();
    try {
        await state.handle(state.message(111111111, 'group', { chat: { id: -1, type: 'group' } }));
        await state.handle(state.message(111111111, 'forward', { forward_origin: { type: 'hidden_user' } }));
        await state.handle(state.message(111111111, 'old', { date: time / 1000 - 121 }));
        await state.handle(state.callback(111111111, 'customer_account', { from: { id: botId + 1, is_bot: true } }));
        assert.equal(state.calls.length, 0); assert.equal(state.sent.length, 0); assert.equal(state.edited.length, 0);
        await state.handle(state.message(333333333, 'Запрос чужого аккаунта'));
        assert.match(state.sent.at(-1).text, /Подключить Telegram/);
        assert.deepEqual(state.store.supportHistory(state.first), []);
    } finally { state.store.close(); }
});

test('an uncertain Telegram edit is never retried or duplicated with a send', async () => {
    const state = fixture(); let edits = 0;
    try {
        const handle = createCustomerHandler({ call: state.call, send: state.send, botId, now: () => time, answerCallback: async () => {}, edit: async () => { edits++; throw Object.assign(new Error('synthetic'), { code: 'NETWORK_FAILED' }); } });
        await assert.rejects(handle(state.callback(111111111, 'customer_home')), error => error.code === 'NETWORK_FAILED');
        assert.equal(edits, 1); assert.equal(state.sent.length, 0);
    } finally { state.store.close(); }
});

for (const reason of ['identity', 'webhook', 'gateway']) test('customer preflight refuses another receiver before polling: ' + reason, async () => {
    let polls = 0;
    const result = await runCustomerBot({ config, api: { getMe: async () => ({ id: botId, is_bot: true, username: reason === 'identity' ? config.adminUsername : config.username }), getWebhookInfo: async () => ({ url: reason === 'webhook' ? 'https://example.invalid/hook' : '' }), getUpdates: async () => { polls++; return []; } }, call: async () => ({ ready: true, botUsername: reason === 'gateway' ? 'another_customer_bot' : config.username }), now: () => time, signal: new AbortController().signal });
    assert.equal(result.status, 'blocked'); assert.equal(polls, 0);
});

test('customer receiver preserves offsets and delivers one native administrator reply to its own recipient', async () => {
    const state = fixture(); const controller = new AbortController(); const offsets = []; let polls = 0;
    try {
        state.store.append(state.first, 'user', 'Вопрос'); const id = state.store.handoff(state.first);
        state.store.supportMessage(id, 'a'.repeat(32), 'Ответ администратора');
        const update = state.message(222222222, 'Другой вопрос');
        const api = { getMe: async () => ({ id: botId, is_bot: true, username: config.username }), getWebhookInfo: async () => ({ url: '' }), answerCallback: async () => {}, send: state.send, getUpdates: async () => { if (polls++) { controller.abort(); return []; } return [update, update]; } };
        const result = await runCustomerBot({ api, config, call: state.call, signal: controller.signal, now: () => time, sleep: async () => {}, loadOffset: () => 0, saveOffset: value => offsets.push(value) });
        assert.equal(result.status, 'stopped'); assert.deepEqual(offsets, [update.update_id + 1]);
        assert.equal(state.sent.filter(item => item.id === 111111111 && item.text.includes('Ответ администратора')).length, 1);
        assert.equal(state.store.supportHistory(state.second).filter(item => item.role === 'user').length, 1);
        assert.equal(state.store.customer.claim().delivery, null);
    } finally { state.store.close(); }
});

test('lost outbound acknowledgement becomes uncertain with no automatic repeat or customer data crossover', async () => {
    const state = fixture(); const controller = new AbortController(); let polls = 0; let sends = 0;
    try {
        const id = state.store.handoff(state.first); state.store.supportMessage(id, 'a'.repeat(32), 'Ответ с потерянным подтверждением');
        const api = { getMe: async () => ({ id: botId, is_bot: true, username: config.username }), getWebhookInfo: async () => ({ url: '' }), answerCallback: async () => {}, send: async () => { sends++; throw Object.assign(new Error('synthetic'), { code: 'NETWORK_FAILED' }); }, getUpdates: async () => { if (++polls === 3) controller.abort(); return []; } };
        await runCustomerBot({ api, config, call: state.call, signal: controller.signal, now: () => time, sleep: async () => {} });
        assert.equal(sends, 1); assert.equal(state.store.customer.claim().delivery, null);
        assert.equal(state.store.supportHistory(state.first).length, 1); assert.deepEqual(state.store.supportHistory(state.second), []);
    } finally { state.store.close(); }
});
