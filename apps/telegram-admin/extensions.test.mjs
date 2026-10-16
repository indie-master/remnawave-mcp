import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMenuSession } from './menu-session.mjs';
import { createVoiceInput } from './voice-client.mjs';
import { readExtensions } from './extensions.mjs';
import { createUserAdministration, createAdminHandler } from './admin-users.mjs';
import { createBusinessAdmin } from './business-client.mjs';
import { createBusinessStore } from '../business/store.mjs';

const actor = 123456789;
const timestamp = Date.parse('2026-10-16T10:00:00Z');
const userId = 42;
const message = (text, update_id = 1) => ({ update_id, message: { date: timestamp / 1000, text, from: { id: actor, is_bot: false }, chat: { id: actor, type: 'private' } } });
const callback = (data, update_id) => ({ update_id, callback_query: { id: 'cb', data, from: { id: actor, is_bot: false }, message: { message_id: 10, chat: { id: actor, type: 'private' } } } });

test('auto inline menu collapses and restores without a report or model call', async () => {
    const sent = []; const edited = []; let calls = 0; let revision = 0;
    const session = createMenuSession({ allowedUserId: actor, collapsible: true, nonce: () => String(++revision).padStart(8, '0'), handle: async () => { calls++; }, api: { sendReply: async payload => { sent.push(payload); return { message_id: 10, chat: { id: actor } }; }, editReply: async payload => edited.push(payload), answerCallback: async () => {} } });
    await session.open({ text: 'menu', reply_markup: { inline_keyboard: [[{ text: 'Stats', callback_data: 'q:stats' }]] } });
    const collapse = sent[0].reply_markup.inline_keyboard.at(-1)[0].callback_data;
    await session.process(callback(collapse, 1));
    assert.equal(edited[0].reply_markup.inline_keyboard.length, 1);
    await session.process(callback(edited[0].reply_markup.inline_keyboard[0][0].callback_data, 2));
    assert.equal(edited[1].reply_markup.inline_keyboard.length, 2);
    assert.equal(calls, 0); assert.equal(sent.length, 1);
    await session.process(callback(collapse, 3)); assert.equal(edited.length, 2);
});

test('voice downloads only authorized fresh bounded voice, then reuses text routing', async () => {
    let downloads = 0; let transcriptions = 0;
    const input = createVoiceInput({ allowedUserId: actor, now: () => timestamp, api: { downloadVoice: async () => { downloads++; return Buffer.from('OggS' + '0'.repeat(20)); } }, transcribe: async () => { transcriptions++; return 'сколько юзеров онлайн'; } });
    const voice = message(undefined); voice.message.voice = { duration: 5, file_size: 100, mime_type: 'audio/ogg', file_id: 'synthetic' };
    const stranger = structuredClone(voice); stranger.message.from.id++;
    assert.equal(await input(stranger), null);
    const stale = structuredClone(voice); stale.message.date -= 121;
    assert.equal(await input(stale), null);
    const huge = structuredClone(voice); huge.message.voice.duration = 600;
    await assert.rejects(input(huge), /VOICE_REJECTED/);
    assert.equal((await input(voice)).message.text, 'сколько юзеров онлайн');
    assert.equal(downloads, 1); assert.equal(transcriptions, 1);
    await assert.rejects(input(voice), /VOICE_REJECTED/);
});

test('extensions fail closed and write requires explicit read/field policy', () => {
    assert.equal(readExtensions().voice, false); assert.equal(readExtensions().adminWrite, false);
    for (const env of [{ VOICE_ENABLED: 'yes' }, { VOICE_MAX_SECONDS: '600' }, { ADMIN_WRITE_ENABLED: 'true' }, { ADMIN_ALLOWED_FIELDS: 'id' }, { ADMIN_ALLOWED_FIELDS: 'status,status' }]) assert.throws(() => readExtensions(env));
});

function fixture(options = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'panel-admin-confirmations-'));
    let clock = timestamp; let writes = 0;
    const user = { id: userId, username: 'example_user', status: 'ACTIVE', expireAt: '2026-11-01T00:00:00.000Z', description: '', trafficLimitBytes: 0, subscriptionUrl: 'https://subscription.example.invalid/private-synthetic' };
    const administration = createUserAdministration({ filename: join(directory, 'test.sqlite'), actorId: actor, readEnabled: true, writeEnabled: true, now: () => clock, client: { get: async () => ({ ...user }), patch: async patch => { writes++; if (options.fail) throw new Error('NETWORK_FAILED'); Object.assign(user, patch); } }, ...options });
    return { administration, user, writes: () => writes, advance: (milliseconds = 2001) => { clock += milliseconds; }, close: () => { administration.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('user cards never disclose links; disclosure needs sole-admin one-time confirmation', async () => {
    const state = fixture();
    try {
        const card = await state.administration.card(actor, 'example_user');
        assert.equal(card.subscriptionUrl, undefined); assert.equal(card.email, undefined);
        state.advance();
        const ticket = await state.administration.prepareSubscription(actor, 'example_user');
        assert.equal(JSON.stringify(ticket).includes('private-synthetic'), false);
        await assert.rejects(state.administration.confirm(actor + 1, ticket.id));
        assert.equal((await state.administration.confirm(actor, ticket.id)).subscriptionUrl, state.user.subscriptionUrl);
        await assert.rejects(state.administration.confirm(actor, ticket.id));
        assert.equal(state.writes(), 0);
    } finally { state.close(); }
});

test('admin write preview validates fields, enforces one use and stale data rejection', async () => {
    const state = fixture();
    try {
        await assert.rejects(state.administration.prepare(actor, 'example_user', { id: userId }));
        const ticket = await state.administration.prepare(actor, 'example_user', { status: 'DISABLED' });
        assert.equal(state.writes(), 0);
        await state.administration.confirm(actor, ticket.id); assert.equal(state.writes(), 1);
        await assert.rejects(state.administration.confirm(actor, ticket.id));
        state.advance();
        const stale = await state.administration.prepare(actor, 'example_user', { description: 'new' });
        state.user.description = 'changed elsewhere';
        await assert.rejects(state.administration.confirm(actor, stale.id), /ADMIN_STALE/);
        assert.equal(state.writes(), 1);
    } finally { state.close(); }
});

test('uncertain writes are not retried and expired confirmations remain closed', async () => {
    const state = fixture({ fail: true });
    try {
        const ticket = await state.administration.prepare(actor, 'example_user', { status: 'DISABLED' });
        await assert.rejects(state.administration.confirm(actor, ticket.id));
        await assert.rejects(state.administration.confirm(actor, ticket.id));
        assert.equal(state.writes(), 1);
        state.advance();
        const expired = await state.administration.prepareSubscription(actor, 'example_user');
        state.advance(180001); await assert.rejects(state.administration.confirm(actor, expired.id));
    } finally { state.close(); }
});

for (const outcome of ['done', 'stale', 'uncertain']) test(`confirmed business renewal coordinates panel and ledger safely: ${outcome}`, async () => {
    const state = fixture({ fail: outcome === 'uncertain' });
    const store = createBusinessStore({ filename: ':memory:' });
    try {
        const account = store.provision('renewal@example.invalid', 'synthetic-password-only', userId).id;
        const payment = store.payment(account, 'RUB', 10000); store.approvePayment(payment.id, 'test:receipt1');
        const renewal = store.requestRenewal(account, 'RUB', { units: 3000, days: 30 });
        const handler = createBusinessAdmin({ actorId: actor, administration: state.administration, now: () => timestamp, call: async (path, value) => {
            if (path === '/pending') return { payments: [], renewals: store.pendingRenewals() };
            if (path === '/renewal-reserve') return store.reserveRenewal(value.id, value.proposal);
            if (path === '/renewal-settle') return store.settleRenewal(value.id, value.outcome);
            throw new Error('UNEXPECTED_CALL');
        } });
        const preview = await handler({ allowedUserId: actor, data: 'br:' + renewal.id });
        assert.equal(store.account(account).balances.RUB, 10000); assert.equal(state.writes(), 0);
        const data = preview.reply_markup.inline_keyboard[0][0].callback_data;
        assert.ok(data.startsWith('rc:'));
        if (outcome === 'stale') state.user.description = 'changed elsewhere';
        await handler({ allowedUserId: actor, data }); await handler({ allowedUserId: actor, data });
        assert.equal(store.account(account).balances.RUB, outcome === 'stale' ? 10000 : 7000);
        assert.equal(state.writes(), outcome === 'stale' ? 0 : 1);
    } finally { store.close(); state.close(); }
});

test('one-time administrative proposals persist across process-local service recreation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'panel-proposal-reopen-'));
    const filename = join(directory, 'test.sqlite'); let writes = 0;
    const options = { filename, actorId: actor, readEnabled: true, writeEnabled: true, now: () => timestamp, client: { get: async () => ({ id: userId, username: 'example_user', status: 'ACTIVE', expireAt: '2026-11-01T00:00:00Z' }), patch: async () => { writes++; } } };
    const first = createUserAdministration(options); const proposal = await first.prepare(actor, '42', { status: 'DISABLED' }); first.close();
    const second = createUserAdministration(options);
    try { await second.confirm(actor, proposal.id); await assert.rejects(second.confirm(actor, proposal.id)); assert.equal(writes, 1); }
    finally { second.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('read-only mode refuses writes and malformed admin questions never reach AI fallback', async () => {
    const state = fixture({ writeEnabled: false });
    try {
        await assert.rejects(state.administration.prepare(actor, 'example_user', { status: 'DISABLED' }), /ADMIN_WRITE_DISABLED/);
        const handler = createAdminHandler({ administration: state.administration, actorId: actor });
        assert.ok(await handler({ allowedUserId: actor, text: 'измени user invalid-payload', data: undefined }));
        assert.equal(await handler({ allowedUserId: actor + 1, text: 'пользователь example_user' }), null);
    } finally { state.close(); }
});
