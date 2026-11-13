import test from 'node:test';
import assert from 'node:assert/strict';
import { createUserAdministration, createAdminHandler } from './admin-users.mjs';
import { createDashboard } from './dashboard.mjs';
import { createMenuSession } from './menu-session.mjs';
import { createIntentStore } from './intent-store.mjs';
import { createBudgetedIntent } from './budgeted-intent.mjs';

const actor = 123456789;
function fixture() {
    let clock = Date.parse('2026-10-19T10:00:00Z');
    let sequence = 0; let modelCalls = 0; let reportCalls = 0; let reads = 0; let writes = 0;
    let current;
    const user = { id: 32, username: 'example_user', status: 'ACTIVE', expireAt: '2026-11-01T00:00:00Z', trafficLimitBytes: 0 };
    const administration = createUserAdministration({ filename: ':memory:', actorId: actor, readEnabled: true, now: () => clock, client: {
        get: async reference => { reads++; assert.ok(['32', 'example_user'].includes(reference)); return { ...user }; },
        patch: async () => { writes++; throw new Error('UNEXPECTED_WRITE'); },
    } });
    const store = createIntentStore({ filename: ':memory:', now: () => clock });
    const classify = createBudgetedIntent({ store, classify: async () => { modelCalls++; return { action: 'help', days: 3 }; } });
    const dashboard = createDashboard({ allowedUserId: actor, service: {}, enhancedUi: true, classify, now: () => clock,
        adminHandle: createAdminHandler({ administration, actorId: actor, now: () => clock }),
        extraButtons: [[{ text: 'Найти пользователя', callback_data: 'admin_home' }]],
        mcpRead: async action => {
            reportCalls++;
            assert.equal(action, 'nodes');
            return { nodesTotal: 1, nodesOnline: 1, nodesOffline: 0, nodesDisabled: 0, nodesConnecting: 0, observedAt: new Date(clock).toISOString() };
        },
    });
    const session = createMenuSession({ allowedUserId: actor, handle: dashboard, collapsible: true, api: {
        sendReply: async payload => { current = payload; return { message_id: 1, chat: { id: actor } }; },
        editReply: async payload => { current = payload; },
        answerCallback: async () => {},
    } });
    const chat = { id: actor, type: 'private' };
    const from = { id: actor, is_bot: false };
    const say = async (text, sender = actor) => {
        sequence++;
        await session.process({ update_id: sequence, message: { message_id: sequence + 1, text, date: Math.floor(clock / 1000), chat, from: { ...from, id: sender } } });
        return current;
    };
    return {
        open: () => session.open(dashboard.home()), say,
        click: async action => {
            const button = current.reply_markup.inline_keyboard.flat().find(value => value.callback_data.endsWith(':' + action));
            assert.ok(button, `Missing button ${action}`);
            assert.ok(Buffer.byteLength(button.callback_data) <= 64);
            sequence++;
            await session.process({ update_id: sequence, callback_query: { id: 'callback_' + sequence, data: button.callback_data, from, message: { message_id: 1, chat } } });
            return current;
        },
        advance: milliseconds => { clock += milliseconds; },
        counts: () => ({ reads, writes, modelCalls, reportCalls, quota: store.status().used }),
        close: () => { administration.close(); store.close(); },
    };
}

for (const reference of ['32', 'example_user']) test(`a single top-level search click accepts ${reference} through the real menu and dashboard without AI`, async () => {
    const state = fixture();
    try {
        await state.open();
        assert.match((await state.click('admin_home')).text, /Введите точный/);
        assert.match((await state.say(reference)).text, /example_user/);
        assert.deepEqual(state.counts(), { reads: 1, writes: 0, modelCalls: 0, reportCalls: 0, quota: 0 });
    } finally { state.close(); }
});

for (const reference of ['32', 'example_user']) test(`a bare reference in the operations view requests local search, not subscription periods or AI: ${reference}`, async () => {
    const state = fixture();
    try {
        await state.open(); await state.click('admin_home'); await state.click('admin_operations');
        assert.match((await state.say(reference)).text, /Найти пользователя/);
        assert.deepEqual(state.counts(), { reads: 0, writes: 0, modelCalls: 0, reportCalls: 0, quota: 0 });
    } finally { state.close(); }
});

for (const mode of ['cancel', 'timeout', 'clock']) test(`abandoned user input cannot become a report or model request through the real menu: ${mode}`, async () => {
    const state = fixture();
    try {
        await state.open(); await state.click('admin_home');
        if (mode === 'cancel') await state.click('admin_cancel_input');
        else state.advance(mode === 'timeout' ? 120000 : -1);
        const first = await state.say('32');
        assert.match(first.text, mode === 'cancel' ? /Найти пользователя/ : /истекло/);
        assert.match((await state.say('example_user')).text, /Найти пользователя/);
        assert.deepEqual(state.counts(), { reads: 0, writes: 0, modelCalls: 0, reportCalls: 0, quota: 0 });
    } finally { state.close(); }
});

test('user navigation discards report follow-up context but keeps explicit reports and owner input working', async () => {
    const state = fixture();
    try {
        await state.open(); await state.say('ноды');
        state.advance(6000); await state.say('/menu'); await state.click('admin_home'); await state.click('admin_operations');
        assert.match((await state.say('а онлайн')).text, /Уточните раздел/);
        assert.equal(state.counts().reportCalls, 1);
        assert.match((await state.say('ноды')).text, /Состояние нод/);
        state.advance(6000); await state.say('/menu'); await state.click('admin_home');
        await state.say('32', actor + 1);
        assert.equal(state.counts().reads, 0);
        assert.match((await state.say('32')).text, /example_user/);
        assert.deepEqual(state.counts(), { reads: 1, writes: 0, modelCalls: 0, reportCalls: 2, quota: 0 });
    } finally { state.close(); }
});
