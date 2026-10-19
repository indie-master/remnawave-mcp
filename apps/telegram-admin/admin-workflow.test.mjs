import test from 'node:test';
import assert from 'node:assert/strict';
import { createUserAdministration, createAdminHandler } from './admin-users.mjs';
import { createDashboard } from './dashboard.mjs';
import { readExtensions } from './extensions.mjs';
import { validateExtensionConfiguration } from './ops-config.mjs';

const actor = 123456789;
const start = Date.parse('2026-10-19T10:00:00Z');
function fixture(options = {}) {
    let clock = start; let reads = 0; let writes = 0;
    const user = { id: 42, username: 'example_user', status: 'ACTIVE', expireAt: '2026-11-01T00:00:00Z', description: '', trafficLimitBytes: 0, subscriptionUrl: 'https://subscription.example.invalid/private-synthetic' };
    const administration = createUserAdministration({ filename: ':memory:', actorId: actor, readEnabled: true, writeEnabled: true, now: () => clock, client: {
        get: async () => { reads++; return { ...user, ...(options.wrongTarget ? { id: 43 } : {}) }; },
        patch: async changes => { writes++; if (options.fail) throw new Error('UNAVAILABLE'); Object.assign(user, changes); },
    }, ...options });
    const handle = createAdminHandler({ administration, actorId: actor, now: () => clock, renewalDays: [7, 30] });
    const send = (text = '', data, allowedUserId = actor) => handle({ text, data, allowedUserId });
    return { administration, handle, send, user, now: () => clock, advance: (milliseconds = 2001) => { clock += milliseconds; }, counts: () => ({ reads, writes }) };
}

test('search button consumes only exact owner input and user cards never expose the subscription URL', async () => {
    const state = fixture();
    try {
        await state.send('', 'admin_search');
        assert.equal(await state.send('42', undefined, actor + 1), null);
        const card = await state.send('42');
        assert.match(card.text, /example_user/);
        assert.ok(!JSON.stringify(card).includes('private-synthetic'));
        assert.deepEqual(state.counts(), { reads: 1, writes: 0 });
        assert.ok(card.reply_markup.inline_keyboard.flat().some(button => button.callback_data === 'ar:42'));
        state.advance(); await state.send('', 'admin_search');
        assert.match((await state.send('example user')).text, /точный ID/);
        assert.equal(state.counts().reads, 1);
    } finally { state.administration.close(); }
});

test('renewal buttons only prepare a preview; an explicit one-use confirmation performs one write', async () => {
    const state = fixture();
    try {
        const choices = await state.send('', 'ar:42');
        assert.deepEqual(choices.reply_markup.inline_keyboard[0], [{ text: '+7 дн.', callback_data: 'ap:42:7' }]);
        assert.match((await state.send('', 'ap:42:365')).text, /Операция недоступна/);
        assert.deepEqual(state.counts(), { reads: 0, writes: 0 });
        const preview = await state.send('', 'ap:42:30');
        assert.equal(state.counts().writes, 0);
        assert.match(preview.text, /expireAt/);
        const key = preview.reply_markup.inline_keyboard[0][0].callback_data;
        assert.match((await state.send('', key)).text, /подтверждено панелью/);
        assert.match((await state.send('', key)).text, /устарело/);
        assert.equal(state.counts().writes, 1);
        const history = await state.send('', 'admin_operations');
        assert.match(history.text, /done/);
        assert.ok(!history.text.includes('private-synthetic'));
    } finally { state.administration.close(); }
});

test('field editing validates policy, previews the target and rejects stale data without writing', async () => {
    const state = fixture({ allowedFields: ['description'] });
    try {
        assert.match((await state.send('', 'af:42:email')).text, /не разрешено/);
        await state.send('', 'af:42:description');
        const preview = await state.send('новое описание');
        assert.equal(state.user.description, '');
        state.user.description = 'изменено другим оператором';
        assert.match((await state.send('', preview.reply_markup.inline_keyboard[0][0].callback_data)).text, /изменились/);
        assert.equal(state.counts().writes, 0);
    } finally { state.administration.close(); }
});

for (const mode of ['cancel', 'timeout', 'clock', 'home', 'business']) test(`interactive admin input fails closed: ${mode}`, async () => {
    const state = fixture();
    try {
        await state.send('', 'admin_search');
        if (mode === 'cancel') await state.send('', 'admin_cancel_input');
        if (mode === 'home') await state.send('', 'home');
        if (mode === 'business') assert.equal(await state.send('сверка ' + 'a'.repeat(24) + ' возврат проверена панель'), null);
        if (mode === 'timeout') state.advance(120000);
        if (mode === 'clock') state.advance(-1);
        const result = await state.send('42');
        if (['timeout', 'clock'].includes(mode)) assert.match(result.text, /истекло/);
        else assert.equal(result, null);
        assert.deepEqual(state.counts(), { reads: 0, writes: 0 });
    } finally { state.administration.close(); }
});

test('read-only cards expose no mutation controls and forged requests cannot read a write token', async () => {
    const state = fixture({ writeEnabled: false });
    try {
        const card = await state.send('пользователь 42');
        assert.ok(!card.reply_markup.inline_keyboard.flat().some(button => /^a[revdpf]:/.test(button.callback_data)));
        assert.match((await state.send('', 'ap:42:30')).text, /выключены/);
        assert.equal(state.counts().reads, 1);
        assert.equal(state.counts().writes, 0);
    } finally { state.administration.close(); }
});

test('a mismatched upstream user is never displayed, proposed or modified', async () => {
    const state = fixture({ wrongTarget: true });
    try {
        assert.match((await state.send('пользователь 42')).text, /недоступна/);
        state.advance();
        assert.match((await state.send('продли 42 на 30 дней')).text, /недоступна/);
        assert.equal(state.counts().writes, 0);
        assert.deepEqual(state.administration.operations(actor), []);
    } finally { state.administration.close(); }
});

test('admin extensions do not intercept ordinary expiry reports and disabled billing commands cannot spend AI budget', async () => {
    const state = fixture(); let modelCalls = 0; let reports = 0; let sequence = 0;
    try {
        const handle = createDashboard({ allowedUserId: actor, enhancedUi: true, now: state.now, adminHandle: state.handle, service: {}, classify: async () => { modelCalls++; return { action: 'help', days: 3 }; }, mcpRead: async (_action, days) => { reports++; return { days, users: [], count: 0, complete: true, observedAt: new Date(start).toISOString() }; } });
        const request = text => handle({ update_id: ++sequence, message: { text, date: state.now() / 1000, chat: { id: actor, type: 'private' }, from: { id: actor, is_bot: false } } });
        assert.match((await request('подписка истекает в ближайшие три дня')).text, /Подписки: ближайшие 3/);
        assert.match((await request('сверка ' + 'a'.repeat(24) + ' возврат проверена панель')).text, /не включены/);
        assert.equal(modelCalls, 0); assert.equal(reports, 1);
    } finally { state.administration.close(); }
});

test('preset configuration is optional, finite, unique and validated by the host editor', () => {
    assert.deepEqual(readExtensions().renewalDays, [1, 7, 30, 90]);
    assert.deepEqual(validateExtensionConfiguration('ADMIN_RENEWAL_DAYS=3,14,30').renewalDays, [3, 14, 30]);
    for (const value of ['0', '367', '7,7', '1, 3', '1,2,3,4,5,6,7,8,9', '1e2']) assert.throws(() => readExtensions({ ADMIN_RENEWAL_DAYS: value }));
});
