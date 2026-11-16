import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetUserByIdCommand, UpdateUserCommand } from '@remnawave/backend-contract';
import { createUserClient, createUserAdministration, createAdminHandler } from './admin-users.mjs';
import { createBusinessStore } from '../business/store.mjs';
import { createBusinessAdmin } from './business-client.mjs';

const actor = 123456789;
const day = 86400000;
function fixture({ expired = false, failure, now = Date.now } = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'panel-expiry-transport-'));
    const readTokenFile = join(directory, 'synthetic-read.txt');
    const writeTokenFile = join(directory, 'synthetic-write.txt');
    writeFileSync(readTokenFile, 'synthetic-read-only', { mode: 0o600 });
    writeFileSync(writeTokenFile, 'synthetic-write-only', { mode: 0o600 });
    const user = { id: 42, username: 'example_user', status: expired ? 'EXPIRED' : 'ACTIVE', expireAt: new Date(now() + (expired ? -day : 3 * day)).toISOString(), description: '', trafficLimitBytes: 0 };
    const writes = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        assert.equal(new URL(url).origin, 'https://panel.example.invalid');
        assert.equal(options.redirect, 'error');
        if (options.method === 'GET') {
            assert.equal(new URL(url).pathname, GetUserByIdCommand.url(42));
            assert.equal(options.headers.Authorization, 'Bearer synthetic-read-only');
            return Response.json({ response: { ...user } });
        }
        assert.equal(options.method, 'PATCH');
        assert.equal(new URL(url).pathname, UpdateUserCommand.url);
        assert.equal(options.headers.Authorization, 'Bearer synthetic-write-only');
        const body = JSON.parse(options.body);
        writes.push(body);
        assert.equal(UpdateUserCommand.RequestBodySchema.safeParse(body).success, true);
        if (failure === 'network') throw new Error('SYNTHETIC_NETWORK_FAILURE');
        if (Number.isInteger(failure)) return Response.json({ message: 'synthetic-upstream-private-value' }, { status: failure });
        Object.assign(user, body);
        return Response.json({ response: { ...user } });
    };
    const client = createUserClient({ baseUrl: 'https://panel.example.invalid', readTokenFile, writeTokenFile });
    const administration = createUserAdministration({ filename: ':memory:', actorId: actor, readEnabled: true, writeEnabled: true, client, now });
    const handle = createAdminHandler({ administration, actorId: actor, now });
    return {
        user, writes, administration,
        send: (text = '', data) => handle({ text, data, allowedUserId: actor }),
        close: () => {
            globalThis.fetch = originalFetch;
            administration.close();
            rmSync(readTokenFile); rmSync(writeTokenFile); rmdirSync(directory);
        },
    };
}

for (const expired of [false, true]) test(`renewal uses the real contract/client boundary and sends one ISO date after confirmation: expired=${expired}`, async () => {
    const clock = Date.now();
    const state = fixture({ expired, now: () => clock });
    try {
        const expected = new Date(Math.max(clock, Date.parse(state.user.expireAt)) + day).toISOString();
        const preview = await state.send('', 'ap:42:1');
        assert.match(preview.text, /Новый срок/);
        assert.ok(preview.text.includes(expected));
        assert.equal(state.writes.length, 0);
        const key = preview.reply_markup.inline_keyboard[0][0].callback_data;
        assert.match((await state.send('', key)).text, /подтверждено панелью/);
        assert.deepEqual(state.writes, [{ id: 42, expireAt: expected }]);
        assert.equal(state.user.expireAt, expected);
        assert.equal(state.user.status, expired ? 'EXPIRED' : 'ACTIVE');
        assert.match((await state.send('', key)).text, /устарело/);
        assert.equal(state.writes.length, 1);
    } finally { state.close(); }
});

test('manual expiry changes normalize the contract Date back to a JSON string before the real HTTP boundary', async () => {
    const state = fixture();
    try {
        const input = new Date(Date.now() + 7 * day).toISOString().slice(0, -1) + '+03:00';
        const preview = await state.send(`измени 42 expireAt=${input}`);
        assert.equal(state.writes.length, 0);
        assert.match((await state.send('', preview.reply_markup.inline_keyboard[0][0].callback_data)).text, /подтверждено панелью/);
        assert.deepEqual(state.writes, [{ id: 42, expireAt: new Date(input).toISOString() }]);
    } finally { state.close(); }
});

test('expiry validation at confirmation happens before uncertain execution and before any PATCH', async context => {
    const clock = Date.parse('2030-01-01T00:00:00Z');
    context.mock.timers.enable({ apis: ['Date'], now: clock });
    const state = fixture();
    try {
        const ticket = await state.administration.prepare(actor, '42', { expireAt: new Date(clock + 60000).toISOString() });
        context.mock.timers.tick(61000);
        await assert.rejects(state.administration.confirm(actor, ticket.id), /ADMIN_INVALID_CHANGE/);
        assert.equal(state.writes.length, 0);
        assert.equal(state.administration.receipt(actor, ticket.id), 'rejected');
        await assert.rejects(state.administration.confirm(actor, ticket.id), /EXPIRED/);
    } finally { state.close(); }
});

for (const failure of [403, 503, 'network']) test(`a real expiry write failure is not retried or misreported as local validation: ${failure}`, async () => {
    const state = fixture({ failure });
    try {
        const ticket = await state.administration.prepareRenewal(actor, '42', 1);
        await assert.rejects(state.administration.confirm(actor, ticket.id), error => {
            assert.ok(!error.message.includes('synthetic-upstream-private-value'));
            assert.ok(!error.message.includes('ADMIN_INVALID_CHANGE'));
            return true;
        });
        assert.equal(state.writes.length, 1);
        assert.equal(state.administration.receipt(actor, ticket.id), 'uncertain');
        await assert.rejects(state.administration.confirm(actor, ticket.id), /EXPIRED/);
        assert.equal(state.writes.length, 1);
    } finally { state.close(); }
});

for (const failure of [undefined, 503]) test(`billing renewal uses the real date transport and settles or holds exactly one reserve: failure=${failure}`, async () => {
    const state = fixture({ expired: true, failure });
    const store = createBusinessStore({ filename: ':memory:' });
    try {
        const account = store.provision('expiry@example.invalid', 'synthetic-password-only', 42).id;
        const payment = store.payment(account, 'RUB', 10000); store.approvePayment(payment.id, 'test:expiry-receipt');
        const renewal = store.requestRenewal(account, 'RUB', { units: 3000, days: 1 });
        const handle = createBusinessAdmin({ actorId: actor, administration: state.administration, call: async (path, value) => {
            if (path === '/pending') return { payments: [], renewals: store.pendingRenewals() };
            if (path === '/renewal-reserve') return store.reserveRenewal(value.id, value.proposal);
            if (path === '/renewal-settle') return store.settleRenewal(value.id, value.outcome);
            throw new Error('UNEXPECTED_PATH');
        } });
        const preview = await handle({ allowedUserId: actor, data: 'br:' + renewal.id });
        assert.equal(state.writes.length, 0); assert.equal(store.account(account).balances.RUB, 10000);
        const data = preview.reply_markup.inline_keyboard[0][0].callback_data;
        const result = await handle({ allowedUserId: actor, data });
        assert.match(result.text, failure ? /Средства удержаны/ : /Подписка продлена/);
        assert.equal(store.renewals(account)[0].state, failure ? 'uncertain' : 'done');
        assert.equal(store.account(account).balances.RUB, 7000);
        await handle({ allowedUserId: actor, data });
        assert.equal(state.writes.length, 1);
    } finally { store.close(); state.close(); }
});
