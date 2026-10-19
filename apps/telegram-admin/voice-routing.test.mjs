import test from 'node:test';
import assert from 'node:assert/strict';
import { createDashboard } from './dashboard.mjs';
import { createBudgetedIntent } from './budgeted-intent.mjs';
import { createIntentStore } from './intent-store.mjs';
import { createVoiceInput } from './voice-client.mjs';
import { createMenuSession } from './menu-session.mjs';

const actor = 123456789;
const start = Date.parse('2026-10-19T09:00:00Z');
const question = 'синтетический голосовой вопрос';

function fixture({ enhancedUi = true, dailyLimit = 100, fail = false } = {}) {
    let clock = start;
    let sequence = 0;
    let modelCalls = 0;
    let readinessCalls = 0;
    let reads = 0;
    const events = [];
    const store = createIntentStore({ filename: ':memory:', now: () => clock, dailyLimit });
    const model = Object.assign(async () => {
        modelCalls++;
        if (fail) throw new Error('AI_UNAVAILABLE');
        return { action: 'stats', days: 3 };
    }, { checkReady: async () => { readinessCalls++; } });
    const classify = createBudgetedIntent({ store, classify: model, onEvent: event => events.push(event) });
    const report = async () => { reads++; return { totalUsers: 12, usersOnline: 3, observedAt: new Date(clock).toISOString() }; };
    const handle = createDashboard({ allowedUserId: actor, enhancedUi, classify, mcpRead: report, service: { stats: report }, now: () => clock, onDiagnostic: event => events.push(event) });
    const message = (text, voice = true) => ({ update_id: ++sequence, ...(voice ? { inputSource: 'local-voice' } : {}), message: { date: clock / 1000, text, from: { id: actor, is_bot: false }, chat: { id: actor, type: 'private' } } });
    const callback = data => ({ update_id: ++sequence, callback_query: { id: 'synthetic_callback', data, from: { id: actor, is_bot: false }, message: { message_id: 1, chat: { id: actor, type: 'private' } } } });
    return { handle, classify, store, events, message, callback, advance: milliseconds => { clock += milliseconds; }, counts: () => ({ modelCalls, readinessCalls, reads }), now: () => clock };
}

for (const enhancedUi of [true, false]) test(`local voice reaches known commands without AI, enhanced UI ${enhancedUi}`, async () => {
    const state = fixture({ enhancedUi });
    try {
        const input = createVoiceInput({ allowedUserId: actor, now: state.now, api: { downloadVoice: async () => Buffer.from('OggS' + '0'.repeat(20)) }, transcribe: async () => 'Пришли статистику.' });
        const update = state.message(undefined, false);
        update.message.voice = { duration: 2, file_size: 24, mime_type: 'audio/ogg', file_id: 'synthetic' };
        const transcribed = await input(update);
        assert.equal(transcribed.inputSource, 'local-voice');
        assert.equal(transcribed.message.voice, undefined);
        assert.match((await state.handle(transcribed)).text, /Статистика/);
        assert.deepEqual(state.counts(), { modelCalls: 0, readinessCalls: 0, reads: 1 });
        assert.equal(state.store.status().used, 0);
    } finally { state.store.close(); }
});

test('cached voice uses fresh panel data without confirmation, quota or model readiness calls', async () => {
    const state = fixture();
    try {
        state.store.put(question, { action: 'stats', days: 3 });
        assert.match((await state.handle(state.message(question))).text, /Статистика/);
        state.advance(15000);
        assert.match((await state.handle(state.message(question))).text, /Статистика/);
        assert.deepEqual(state.counts(), { modelCalls: 0, readinessCalls: 0, reads: 2 });
        assert.equal(state.store.status().used, 0);
        assert.ok(state.events.some(event => event.source === 'cache'));
    } finally { state.store.close(); }
});

test('unknown voice previews escaped text and needs sole-admin single-use approval before spending', async () => {
    const state = fixture();
    try {
        const text = question + ' <b>пример</b>';
        const preview = await state.handle(state.message(text));
        assert.match(preview.text, /&lt;b&gt;пример&lt;\/b&gt;/);
        assert.match(preview.text, /До подтверждения ИИ не вызывался/);
        const approval = preview.reply_markup.inline_keyboard[0][0].callback_data;
        assert.ok(approval.length + 11 <= 64);
        assert.ok(!approval.includes(text));
        assert.deepEqual(state.counts(), { modelCalls: 0, readinessCalls: 0, reads: 0 });
        assert.equal(state.store.status().used, 0);
        const stranger = state.callback(approval);
        stranger.callback_query.from.id++;
        assert.equal(await state.handle(stranger), null);
        assert.match((await state.handle(state.callback(approval))).text, /Статистика/);
        assert.match((await state.handle(state.callback(approval))).text, /уже использовано/);
        assert.deepEqual(state.counts(), { modelCalls: 1, readinessCalls: 1, reads: 1 });
        assert.equal(state.store.status().used, 1);
        assert.ok(!JSON.stringify(state.events).includes(text));
    } finally { state.store.close(); }
});

for (const outcome of ['cancel', 'expired', 'backwards', 'superseded', 'restart']) test(`voice confirmation fails closed without a model request: ${outcome}`, async () => {
    const state = fixture();
    let replacement;
    try {
        const preview = await state.handle(state.message(question));
        const approval = preview.reply_markup.inline_keyboard[0][0].callback_data;
        if (outcome === 'cancel') assert.match((await state.handle(state.callback(preview.reply_markup.inline_keyboard[0][1].callback_data))).text, /отменена/);
        if (outcome === 'expired') state.advance(180000);
        if (outcome === 'backwards') state.advance(-1);
        if (outcome === 'superseded') await state.handle(state.message(question + ' другой'));
        if (outcome === 'restart') replacement = fixture();
        assert.match((await (replacement ?? state).handle(state.callback(approval))).text, /устарело|уже использовано/);
        assert.deepEqual(state.counts(), { modelCalls: 0, readinessCalls: 0, reads: 0 });
        assert.equal(state.store.status().used, 0);
        if (replacement) assert.equal(replacement.store.status().used, 0);
    } finally { replacement?.store.close(); state.store.close(); }
});

test('voice approval respects the existing daily cap and never retries an uncertain classifier', async () => {
    for (const fail of [true, false]) {
        const state = fixture({ dailyLimit: 1, fail });
        try {
            const preview = await state.handle(state.message(question));
            const approval = preview.reply_markup.inline_keyboard[0][0].callback_data;
            if (!fail) state.store.reserve();
            assert.match((await state.handle(state.callback(approval))).text, fail ? /Попытка учтена/ : /суточный лимит/);
            assert.match((await state.handle(state.callback(approval))).text, /уже использовано/);
            assert.equal(state.counts().modelCalls, fail ? 1 : 0);
            assert.equal(state.counts().reads, 0);
            assert.equal(state.store.status().used, 1);
        } finally { state.store.close(); }
    }
});

test('voice clarification and blocked writes bypass AI, and unknown typed text keeps its old flow', async () => {
    const state = fixture();
    try {
        assert.match((await state.handle(state.message('статистика нод за месяц'))).text, /Уточните раздел/);
        assert.match((await state.handle(state.message('удали пользователя'))).text, /ИИ не вызывался/);
        assert.equal(state.counts().modelCalls, 0);
        assert.match((await state.handle(state.message(question, false))).text, /Статистика/);
        assert.equal(state.counts().modelCalls, 1);
        assert.equal(state.store.status().used, 1);
    } finally { state.store.close(); }
});

test('voice confirmation edits the current inline message and stale menu callbacks cannot spend twice', async () => {
    const state = fixture();
    const sent = [];
    const edited = [];
    const session = createMenuSession({ handle: state.handle, allowedUserId: actor, collapsible: true, api: {
        sendReply: async payload => { sent.push(payload); return { message_id: sent.length, chat: { id: actor } }; },
        editReply: async payload => { edited.push(payload); }, answerCallback: async () => {},
    } });
    try {
        await session.open(state.handle.home());
        await session.process(state.message(question));
        const approval = sent[1].reply_markup.inline_keyboard[0][0].callback_data;
        const update = state.callback(approval);
        update.callback_query.message.message_id = 2;
        await session.process(update);
        const duplicate = state.callback(approval);
        duplicate.callback_query.message.message_id = 2;
        await session.process(duplicate);
        assert.equal(sent.length, 2);
        assert.equal(edited.length, 1);
        assert.match(edited[0].text, /Статистика/);
        assert.equal(state.counts().modelCalls, 1);
    } finally { state.store.close(); }
});
