import test from 'node:test';
import assert from 'node:assert/strict';
import { createBusinessStore, createSupport } from '../business/store.mjs';
import { createBusinessAdmin } from './business-client.mjs';
import { createDashboard } from './dashboard.mjs';
import { createMenuSession } from './menu-session.mjs';
import { createTelegramApi } from '../telegram-client/telegram-api.mjs';
import { runServerBot } from './server-loop.mjs';

const actor = 123456789;
async function fixture() {
    const store = createBusinessStore({ filename: ':memory:' });
    const first = store.provision('first@example.invalid', 'synthetic-password-only', 48).id;
    const second = store.provision('second@example.invalid', 'synthetic-password-only', 49).id;
    store.append(first, 'user', 'Первый вопрос'); store.append(second, 'user', 'Второй вопрос');
    const tickets = [store.handoff(first), store.handoff(second)];
    let timestamp = Date.parse('2026-11-10T12:00:00Z'); let sequence = 0; let messageId = 100; let modelCalls = 0; let uncertain = false; let readFailure = false; let editFailure = false; let wrongThread;
    const requests = []; const delivered = new Map();
    const call = async (path, value) => {
        requests.push({ path, value });
        if (path === '/pending') return { payments: [], renewals: [], support: store.pendingSupport() };
        if (path.startsWith('/support/')) { if (readFailure) { readFailure = false; throw new Error('SYNTHETIC_READ_UNAVAILABLE'); } if (wrongThread !== undefined) { const index = wrongThread; wrongThread = undefined; return store.supportThread(tickets[index]); } return store.supportThread(path.split('/').at(-1)); }
        if (path === '/support-close') return store.closeSupport(value.id, value.version);
        if (path === '/support-message') { const result = store.supportMessage(value.id, value.key, value.text); if (uncertain) throw new Error('SYNTHETIC_RESPONSE_LOST'); return result; }
        throw new Error('UNEXPECTED_ENDPOINT');
    };
    const admin = createBusinessAdmin({ actorId: actor, call, now: () => timestamp });
    const api = createTelegramApi({ token: '123456789:' + 'a'.repeat(35), allowedUserId: actor, enableButtons: true, fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body); const method = String(url).split('/').at(-1);
        if (method === 'answerCallbackQuery') return new Response(JSON.stringify({ ok: true, result: true }));
        assert.ok(['sendMessage', 'editMessageText'].includes(method)); assert.equal(body.chat_id, actor);
        assert.equal(body.supportContext, undefined);
        if (method === 'editMessageText' && editFailure) { editFailure = false; throw new Error('SYNTHETIC_TELEGRAM_UNAVAILABLE'); }
        const id = method === 'sendMessage' ? ++messageId : body.message_id;
        delivered.set(id, body);
        return new Response(JSON.stringify({ ok: true, result: { message_id: id, chat: { id: actor } } }));
    } });
    const dashboard = createDashboard({ allowedUserId: actor, service: {}, enhancedUi: true, now: () => timestamp, adminHandle: admin, classify: async () => { modelCalls++; throw new Error('MUST_NOT_INFER'); }, mcpRead: async () => { throw new Error('MUST_NOT_READ_PANEL'); }, extraButtons: [[{ text: 'Поддержка', callback_data: 'business_support' }]] });
    const session = createMenuSession({ api, handle: dashboard, allowedUserId: actor, onDelivery: admin.delivered });
    await session.open(dashboard.home()); const main = messageId;
    const click = async (id, action) => {
        const button = delivered.get(id).reply_markup.inline_keyboard.flat().find(item => item.callback_data?.endsWith(':' + action) || (action === 'answer' && item.callback_data?.includes(':bsr:')) || (action === 'close' && item.callback_data?.includes(':bsc:')));
        assert.ok(button, action);
        await session.process({ update_id: ++sequence, callback_query: { id: 'callback' + sequence, from: { id: actor, is_bot: false }, message: { message_id: id, chat: { id: actor, type: 'private' } }, data: button.callback_data } });
    };
    const write = async (text, replyTo, patch = {}) => {
        const update = { update_id: ++sequence, message: { message_id: 10000 + sequence, date: Math.floor(timestamp / 1000), chat: { id: actor, type: 'private' }, from: { id: actor, is_bot: false }, text, ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}), ...patch } };
        await session.process(update); return update;
    };
    await click(main, 'business_support');
    const open = async index => { await click(main, 'bh:' + tickets[index]); return [...delivered].find(([, body]) => body.reply_markup?.inline_keyboard.flat().some(button => button.callback_data?.includes(':bsc:')) && body.reply_markup.inline_keyboard.flat().some(button => button.callback_data?.endsWith(':bh:' + tickets[index])))?.[0]; };
    const rawClick = async (id, data) => session.process({ update_id: ++sequence, callback_query: { id: 'callback' + sequence, from: { id: actor, is_bot: false }, message: { message_id: id, chat: { id: actor, type: 'private' } }, data } });
    return { store, first, second, tickets, admin, session, delivered, requests, main, click, rawClick, write, open, now: () => timestamp, advance: milliseconds => { timestamp += milliseconds; }, lostResponse: () => { uncertain = true; }, restoreResponse: () => { uncertain = false; }, failRead: () => { readFailure = true; }, failEdit: () => { editFailure = true; }, wrongRead: index => { wrongThread = index; }, modelCalls: () => modelCalls };
}

test('native Telegram replies stay bound to distinct customer cards while the main menu and other card remain intact', async () => {
    const state = await fixture();
    try {
        const firstCard = await state.open(0); const secondCard = await state.open(1);
        assert.notEqual(firstCard, secondCard); assert.notEqual(firstCard, state.main);
        const otherCard = JSON.stringify(state.delivered.get(secondCard));
        const update = await state.write('Ответ именно первому клиенту <текст>', firstCard);
        assert.equal(state.store.supportHistory(state.first).at(-1).text, 'Ответ именно первому клиенту <текст>');
        assert.equal(state.store.supportHistory(state.second).length, 1);
        assert.equal(JSON.stringify(state.delivered.get(secondCard)), otherCard);
        assert.equal(state.store.openSupport(state.first), state.tickets[0]);
        const count = state.requests.length; await state.session.process(update); assert.equal(state.requests.length, count);
        await state.click(secondCard, 'bh:' + state.tickets[1]);
        await state.write('Теперь второму клиенту');
        assert.equal(state.store.supportHistory(state.second).at(-1).text, 'Теперь второму клиенту');
        assert.equal(state.modelCalls(), 0);
        assert.doesNotMatch(state.delivered.get(firstCard).text, /ответ [a-f0-9]{24}/);
    } finally { state.store.close(); }
});

test('native support rejects foreign, forwarded, unknown, expired and cancelled reply contexts before delivery or AI', async () => {
    const state = await fixture();
    try {
        const card = await state.open(0);
        await state.write('Не чужому', card, { from: { id: actor + 1, is_bot: false } });
        await state.write('Пересланное', card, { forward_origin: { type: 'hidden_user' } });
        await state.write('Неизвестная карточка', 999999);
        await state.click(card, 'bh:' + state.tickets[0]); await state.write('/cancel');
        assert.equal(state.requests.filter(item => item.path === '/support-message').length, 0);
        await state.click(card, 'bh:' + state.tickets[0]); state.advance(1800001); await state.write('Истёкший ввод');
        state.advance(1800001); await state.write('Старая карточка', card);
        assert.equal(state.requests.filter(item => item.path === '/support-message').length, 0);
        assert.equal(state.modelCalls(), 0); assert.equal(state.store.supportHistory(state.first).length, 1);
    } finally { state.store.close(); }
});

test('a lost support response never retries and customer message arrival prevents closing a stale card', async () => {
    const state = await fixture();
    try {
        const card = await state.open(0); state.lostResponse();
        await state.write('Доставлено с потерянным подтверждением', card);
        assert.equal(state.requests.filter(item => item.path === '/support-message').length, 1);
        assert.equal(state.store.supportHistory(state.first).length, 2);
        assert.match(state.delivered.get(card).text, /могло сохраниться/);
        await state.click(card, 'bh:' + state.tickets[0]);
        state.store.append(state.first, 'user', 'Новое непрочитанное сообщение');
        await state.click(card, 'close');
        assert.equal(state.store.openSupport(state.first), state.tickets[0]);
        await state.click(card, 'bh:' + state.tickets[0]); await state.click(card, 'close');
        assert.equal(state.store.openSupport(state.first), undefined);
        await state.write('Ответ после завершения', card);
        assert.equal(state.requests.filter(item => item.path === '/support-message').length, 1);
        assert.equal(state.modelCalls(), 0);
    } finally { state.store.close(); }
});

test('process restart refuses unknown old card bindings without interpreting a reply as an administrative command', async () => {
    const state = await fixture();
    try {
        const card = await state.open(0);
        const fresh = createBusinessAdmin({ actorId: actor, call: async () => { throw new Error('MUST_NOT_CALL'); } });
        const response = await fresh({ allowedUserId: actor, telegramReply: true, replyToMessageId: card, text: 'измени пользователя', updateId: 100 });
        assert.match(response.text, /актуальную карточку/);
        assert.equal(state.store.supportHistory(state.first).length, 1);
    } finally { state.store.close(); }
});

test('escaped customer history stays inside Telegram limits and only confirmed bot delivery creates a native binding', async () => {
    const state = await fixture();
    try {
        for (let index = 0; index < 6; index++) state.store.append(state.first, 'user', '<&>'.repeat(150));
        const card = await state.open(0);
        assert.ok(state.delivered.get(card).text.length <= 4096);
        assert.ok(state.delivered.get(card).text.includes('&lt;'));
        const fresh = createBusinessAdmin({ actorId: actor, call: async path => state.store.supportThread(path.split('/').at(-1)) });
        const response = await fresh({ allowedUserId: actor, data: 'bh:' + state.tickets[0] });
        fresh.delivered(response.supportContext, { message_id: 998, chat: { id: actor + 1 } });
        const blocked = await fresh({ allowedUserId: actor, telegramReply: true, replyToMessageId: 998, updateId: 10, text: 'Не отправлять' });
        assert.match(blocked.text, /актуальную карточку/);
    } finally { state.store.close(); }
});

test('basic bot mode binds delivered support cards and strips private routing metadata from transport', async () => {
    const state = await fixture(); let time = state.now(); let reads = 0; let outgoing = 0;
    try {
        const message = { date: Math.floor(time / 1000), chat: { id: actor, type: 'private' }, from: { id: actor, is_bot: false } };
        const result = await runServerBot({ allowedUserId: actor, botUsername: 'synthetic_admin_bot', service: {}, soleReceiverConfirmed: true, seconds: 60, now: () => time, sleep: async () => {}, adminHandle: state.admin, onReplyDelivery: state.admin.delivered, api: {
            getMe: async () => ({ is_bot: true, username: 'synthetic_admin_bot' }), getWebhookInfo: async () => ({ url: '' }), answerCallback: async () => {},
            getUpdates: async () => { if (reads++) { time += 61000; return []; } return [{ update_id: 100, callback_query: { id: 'openbasic', from: message.from, message, data: 'bh:' + state.tickets[0] } }, { update_id: 101, message: { ...message, message_id: 999, reply_to_message: { message_id: 2 }, text: 'Ответ из базового режима' } }]; },
            sendReply: async payload => { assert.equal(payload.supportContext, undefined); assert.equal(payload.chat_id, actor); return { message_id: ++outgoing, chat: { id: actor } }; },
        } });
        assert.equal(result.reason, 'TIME_LIMIT');
        assert.equal(state.store.supportHistory(state.first).at(-1).text, 'Ответ из базового режима');
        assert.equal(state.store.supportHistory(state.second).length, 1);
    } finally { state.store.close(); }
});

test('opening a customer chat allows several plain replies and repeated reopen without answer or close buttons', async () => {
    const state = await fixture();
    try {
        await state.open(0);
        await state.write('Первое обычное сообщение');
        await state.write('Второе обычное сообщение');
        await state.write('Третье обычное сообщение');
        assert.deepEqual(state.store.supportHistory(state.first).slice(-3).map(item => item.text), ['Первое обычное сообщение', 'Второе обычное сообщение', 'Третье обычное сообщение']);
        assert.equal(state.modelCalls(), 0); assert.equal(state.store.openSupport(state.first), state.tickets[0]);
        await state.open(0); await state.write('После повторного открытия');
        assert.equal(state.store.supportHistory(state.first).at(-1).text, 'После повторного открытия');
        assert.equal(state.store.supportHistory(state.second).length, 1);
    } finally { state.store.close(); }
});

test('a refresh click queued before a reply still reopens that same customer card after delivery', async () => {
    const state = await fixture();
    try {
        const card = await state.open(0);
        const refresh = state.delivered.get(card).reply_markup.inline_keyboard.flat().find(button => button.callback_data?.endsWith(':bh:' + state.tickets[0])).callback_data;
        await state.write('Сообщение из Telegram Reply', card);
        const reads = state.requests.filter(item => item.path === '/support/' + state.tickets[0]).length;
        await state.rawClick(card, refresh);
        assert.equal(state.requests.filter(item => item.path === '/support/' + state.tickets[0]).length, reads + 1);
        assert.equal(state.modelCalls(), 0);
    } finally { state.store.close(); }
});

test('leaving, resuming, switching customers and renewing the idle timer preserve one explicit recipient', async () => {
    const state = await fixture();
    try {
        const firstCard = await state.open(0);
        await state.write('До выхода');
        await state.click(firstCard, 'bsl:' + state.tickets[0]);
        assert.equal(state.store.openSupport(state.first), state.tickets[0]);
        assert.ok(state.delivered.get(firstCard).reply_markup.inline_keyboard.flat().some(button => button.text === '✍️ Продолжить переписку'));
        await state.click(firstCard, 'bh:' + state.tickets[0]); await state.write('После возврата');
        state.advance(20 * 60000); await state.write('Продолжаем через двадцать минут');
        state.advance(20 * 60000); await state.write('Таймер обновлён предыдущим ответом');
        assert.equal(state.store.supportHistory(state.first).at(-1).text, 'Таймер обновлён предыдущим ответом');
        await state.open(1); await state.write('Только второму');
        assert.equal(state.store.supportHistory(state.second).at(-1).text, 'Только второму');
        assert.equal(state.store.supportHistory(state.first).at(-1).text, 'Таймер обновлён предыдущим ответом');
        assert.equal(state.modelCalls(), 0);
    } finally { state.store.close(); }
});

test('unknown delivery pauses additional text until refresh and a temporary read failure recovers in place', async () => {
    const state = await fixture();
    try {
        const card = await state.open(0); state.lostResponse();
        await state.write('Неясная доставка'); await state.write('Не повторять до проверки');
        assert.equal(state.requests.filter(item => item.path === '/support-message').length, 1);
        state.restoreResponse(); state.failRead(); await state.click(card, 'bh:' + state.tickets[0]);
        await state.write('Чтение ещё не подтверждено');
        assert.equal(state.requests.filter(item => item.path === '/support-message').length, 1);
        await state.click(card, 'bh:' + state.tickets[0]); await state.write('Продолжение после восстановления');
        assert.equal(state.store.supportHistory(state.first).at(-1).text, 'Продолжение после восстановления');
        state.failRead(); await state.write('Ответ подтверждён, чтение временно не работает');
        await state.write('Можно продолжить после подтверждённого ответа');
        assert.equal(state.store.supportHistory(state.first).at(-1).text, 'Можно продолжить после подтверждённого ответа');
        assert.equal(state.requests.filter(item => item.path === '/support-message').length, 4);
        assert.equal(state.store.openSupport(state.first), state.tickets[0]);
        assert.equal(state.modelCalls(), 0);
    } finally { state.store.close(); }
});

test('Telegram edit failure after a delivered answer does not invalidate refresh or route the next answer to AI', async () => {
    const state = await fixture();
    try {
        const card = await state.open(0);
        const refresh = state.delivered.get(card).reply_markup.inline_keyboard.flat().find(button => button.callback_data?.endsWith(':bh:' + state.tickets[0])).callback_data;
        state.failEdit();
        await assert.rejects(state.write('Доставлено при сбое карточки'), error => error.code === 'NETWORK_FAILED');
        assert.equal(state.store.supportHistory(state.first).at(-1).text, 'Доставлено при сбое карточки');
        await state.rawClick(card, refresh); await state.write('Следующее сообщение работает');
        assert.equal(state.store.supportHistory(state.first).at(-1).text, 'Следующее сообщение работает');
        assert.equal(state.modelCalls(), 0);
        assert.equal(state.requests.filter(item => item.path === '/support-message').length, 2);
    } finally { state.store.close(); }
});

test('a mismatched thread response cannot silently select another customer for consecutive messages', async () => {
    const state = await fixture();
    try {
        const card = await state.open(0); state.wrongRead(1);
        await state.write('Первому несмотря на неверный ответ чтения');
        await state.write('Следующее сообщение тоже первому');
        assert.equal(state.store.supportHistory(state.first).at(-1).text, 'Следующее сообщение тоже первому');
        assert.equal(state.store.supportHistory(state.second).length, 1);
        state.wrongRead(1); await state.click(card, 'bh:' + state.tickets[0]);
        const sent = state.requests.filter(item => item.path === '/support-message').length;
        await state.write('Не отправлять при неподтверждённом получателе');
        assert.equal(state.requests.filter(item => item.path === '/support-message').length, sent);
        await state.click(card, 'bh:' + state.tickets[0]); await state.write('Восстановили первого');
        assert.equal(state.store.supportHistory(state.first).at(-1).text, 'Восстановили первого');
        assert.equal(state.store.supportHistory(state.second).length, 1); assert.equal(state.modelCalls(), 0);
    } finally { state.store.close(); }
});

test('leaving a conversation is local and does not get stuck when the support backend cannot read', async () => {
    const state = await fixture();
    try {
        const card = await state.open(0); state.failRead(); const reads = state.requests.length;
        await state.click(card, 'bsl:' + state.tickets[0]);
        assert.equal(state.requests.length, reads);
        assert.match(state.delivered.get(card).text, /вышли из переписки/);
        assert.equal(state.store.openSupport(state.first), state.tickets[0]);
        assert.equal(await state.admin({ allowedUserId: actor, updateId: 9999, text: 'Обычный текст после выхода' }), null);
        assert.equal(state.store.supportHistory(state.first).length, 1);
    } finally { state.store.close(); }
});
