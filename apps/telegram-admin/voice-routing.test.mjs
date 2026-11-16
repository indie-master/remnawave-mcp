import test from 'node:test';
import assert from 'node:assert/strict';
import { createDashboard } from './dashboard.mjs';
import { createBudgetedIntent } from './budgeted-intent.mjs';
import { createIntentStore } from './intent-store.mjs';
import { createVoiceInput } from './voice-client.mjs';
import { createMenuSession } from './menu-session.mjs';
import { resolveLocalRequest } from './local-router.mjs';

const actor = 123456789;
const start = Date.parse('2026-10-19T09:00:00Z');
const question = 'синтетический голосовой вопрос';

test('natural subscription expiry word order and inflection preserve bounded future windows', () => {
    for (const [phrase, days] of [
        ['Подписка истекает в ближайшие три дня.', 3],
        ['Подписка заканчивается в ближайшую неделю.', 7],
        ['Подписки истекают в течение месяца.', 30],
        ['Подписки заканчиваются в ближайший день.', 1],
        ['Истекает подписка в ближайшие 14 дней.', 14],
        ['Заканчиваются подписки в ближайшие три дня.', 3],
        ['У кого подписка заканчивается в ближайшие три дня?', 3],
        ['У кого заканчивается подписка в ближайшую неделю?', 7],
        ['У кого подписки заканчиваются в ближайшие три дня?', 3],
        ['У кого скоро заканчивается подписка?', 3],
        ['Подписки истекают в течение трёх дней.', 3],
        ['Подписки заканчиваются в течение двух недель.', 14],
        ['Подписки истекают в течение семи дней.', 7],
        ['Подписки истекают в течение четырнадцати дней.', 14],
        ['Подписки истекают в течение тридцати дней.', 30],
    ]) assert.deepEqual(resolveLocalRequest(phrase).intent, { action: 'expiring', days }, phrase);
});

test('exact offsets, unsupported windows and malformed expiry speech need period clarification, not AI or guessed filters', () => {
    for (const phrase of ['Подписка истекает через три дня.', 'подписки заканчиваются через неделю', 'подписка стекает через три дня', 'подписка стеает через три дня', 'подписки неразборчиво в ближайшую неделю', 'подписка заканчивается до 21 октября', 'подписка истекает в ближайшие два дня', 'подписки истекают в ближайшие 21 день', 'подписка истекает', 'подписки заканчиваются']) assert.deepEqual(resolveLocalRequest(phrase), { kind: 'clarify', topic: 'period' }, phrase);
    for (const phrase of ['не показывай подписки истекающие в ближайшие три дня', 'подписки и ноды', 'подписки пользователя 42 в ближайшие три дня', 'подписки истекли за три дня', 'подписка стекает через три дня на ноде 42']) assert.equal(resolveLocalRequest(phrase).kind, 'clarify', phrase);
    assert.equal(resolveLocalRequest('продли подписку через три дня').kind, 'blocked');
});

for (const enhancedUi of [true, false]) test(`malformed expiry voice offers free period buttons and keeps its transcript, enhanced UI ${enhancedUi}`, async () => {
    const state = fixture({ enhancedUi });
    try {
        const text = 'Подписка стекает через три дня.';
        state.store.put(text, { action: 'stats', days: 3 });
        const answer = await state.handle(state.message(text));
        assert.match(answer.text, /Подписка стекает через три дня/);
        assert.match(answer.text, /Выберите поддерживаемый период/);
        assert.match(answer.text, /«Через N дней» не означает автоматически/);
        assert.ok(answer.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'q:expiring:3'));
        assert.deepEqual(state.counts(), { modelCalls: 0, readinessCalls: 0, reads: 0 });
        assert.equal(state.store.status().used, 0);
        const selected = await state.handle(state.callback('q:expiring:3'));
        assert.match(selected.text, /Подписки: ближайшие 3 дн/);
        assert.deepEqual(state.counts(), { modelCalls: 0, readinessCalls: 0, reads: 1 });
        assert.equal(state.store.status().used, 0);
    } finally { state.store.close(); }
});

for (const enhancedUi of [true, false]) test(`unambiguous expiry voice reads the three-day report without a model, enhanced UI ${enhancedUi}`, async () => {
    const state = fixture({ enhancedUi });
    try {
        const answer = await state.handle(state.message('Подписка истекает в ближайшие три дня.'));
        assert.match(answer.text, /Подписки: ближайшие 3 дн/);
        assert.deepEqual(state.counts(), { modelCalls: 0, readinessCalls: 0, reads: 1 });
        assert.equal(state.store.status().used, 0);
    } finally { state.store.close(); }
});

test('a single extra preposition after a read request preserves the exact report subject', () => {
    for (const [phrase, action] of [
        ['пришли в статистику.', 'stats'],
        ['покажи в общую статистику', 'stats'],
        ['пришли в статистику панели', 'stats'],
        ['пришли в статистику нод', 'nodes'],
        ['пришли в статистику по серверам', 'nodes'],
        ['пришли в статистику пользователей', 'users'],
        ['пришли в статистику клиентов', 'users'],
    ]) assert.equal(resolveLocalRequest(phrase).intent.action, action, phrase);
    for (const phrase of ['пришли в статистику нод за месяц', 'пришли в статистику нод и пользователей', 'не пришли в статистику', 'пришли в статистику без нод', 'пришли в статистику в Москве', 'пришли в в статистику', 'в статистику']) assert.equal(resolveLocalRequest(phrase).kind, 'clarify', phrase);
    assert.equal(resolveLocalRequest('удали в статистику пользователя').kind, 'blocked');
});

test('spoken punctuation preserves exact local meanings and does not discard filters, negations or writes', () => {
    for (const phrase of ['Пришли, статистику.', 'Пришли, пожалуйста, статистику.']) assert.equal(resolveLocalRequest(phrase).intent.action, 'stats', phrase);
    assert.equal(resolveLocalRequest('Пришли, пожалуйста, статистику нод.').intent.action, 'nodes');
    for (const phrase of [',', 'статистика, ноды, пользователи', 'статистика, не нод', 'не, статистику', 'статистика, за месяц', 'подписки, за 3,5 дня']) assert.equal(resolveLocalRequest(phrase).kind, 'clarify', phrase);
    assert.equal(resolveLocalRequest('удали, пользователя').kind, 'blocked');
});

for (const enhancedUi of [true, false]) test(`ambiguous voice displays its escaped local transcript without AI, enhanced UI ${enhancedUi}`, async () => {
    const state = fixture({ enhancedUi });
    try {
        const text = 'статистика нод за месяц <b>пример</b>';
        const answer = await state.handle(state.message(text));
        assert.match(answer.text, /Распознано локально/);
        assert.match(answer.text, /статистика нод за месяц &lt;b&gt;пример&lt;\/b&gt;/);
        assert.match(answer.text, /Уточните раздел/);
        assert.ok(!answer.reply_markup.inline_keyboard.flat().some(button => button.callback_data.startsWith('voice_ai:')));
        assert.deepEqual(state.counts(), { modelCalls: 0, readinessCalls: 0, reads: 0 });
        assert.equal(state.store.status().used, 0);
        assert.ok(!JSON.stringify(state.events).includes(text));
        const typed = await state.handle(state.message(text, false));
        assert.doesNotMatch(typed.text, /Распознано локально/);
    } finally { state.store.close(); }
});

test('voice period clarification displays the transcript and keeps period selection buttons', async () => {
    const state = fixture();
    try {
        const answer = await state.handle(state.message('подписки до завтра'));
        assert.match(answer.text, /Распознано локально/);
        assert.match(answer.text, /подписки до завтра/);
        assert.match(answer.text, /Выберите поддерживаемый период/);
        assert.ok(answer.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'q:expiring:3'));
        assert.deepEqual(state.counts(), { modelCalls: 0, readinessCalls: 0, reads: 0 });
    } finally { state.store.close(); }
});

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
    const report = async (action, days) => {
        reads++;
        const observedAt = new Date(clock).toISOString();
        return action === 'expiring' ? { days, count: 0, users: [], complete: true, scanned: 0, total: 0, observedAt } : { totalUsers: 12, usersOnline: 3, observedAt };
    };
    const handle = createDashboard({ allowedUserId: actor, enhancedUi, classify, mcpRead: report, service: { stats: report, expiring: options => report('expiring', options.days) }, now: () => clock, onDiagnostic: event => events.push(event) });
    const message = (text, voice = true) => ({ update_id: ++sequence, ...(voice ? { inputSource: 'local-voice' } : {}), message: { date: clock / 1000, text, from: { id: actor, is_bot: false }, chat: { id: actor, type: 'private' } } });
    const callback = data => ({ update_id: ++sequence, callback_query: { id: 'synthetic_callback', data, from: { id: actor, is_bot: false }, message: { message_id: 1, chat: { id: actor, type: 'private' } } } });
    return { handle, classify, store, events, message, callback, advance: milliseconds => { clock += milliseconds; }, counts: () => ({ modelCalls, readinessCalls, reads }), now: () => clock };
}

for (const enhancedUi of [true, false]) for (const transcript of ['Пришли статистику.', 'пришли в статистику.']) test(`local voice reaches known commands without AI, enhanced UI ${enhancedUi}: ${transcript}`, async () => {
    const state = fixture({ enhancedUi });
    try {
        const input = createVoiceInput({ allowedUserId: actor, now: state.now, api: { downloadVoice: async () => Buffer.from('OggS' + '0'.repeat(20)) }, transcribe: async () => transcript });
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
