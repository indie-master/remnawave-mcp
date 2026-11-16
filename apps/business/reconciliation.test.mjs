import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBusinessStore } from './store.mjs';
import { createBillingAdministration } from './billing-admin.mjs';
import { validateBusinessEnv } from './config.mjs';
import { createBusinessAdmin } from '../telegram-admin/business-client.mjs';

const actor = 123456789;
const start = Date.parse('2026-10-19T10:00:00Z');
const delay = 300000;
const proof = 'Панель и журнал проверены вручную';
function fixture({ filename = ':memory:', enabled = true, executing = false } = {}) {
    let clock = start;
    const store = createBusinessStore({ filename, reconciliationEnabled: enabled, reviewDelayMs: delay, now: () => clock });
    const account = store.provision('first@example.invalid', 'synthetic-password', 42).id;
    const other = store.provision('second@example.invalid', 'synthetic-password', 43).id;
    const payment = store.payment(account, 'RUB', 10000); store.approvePayment(payment.id, 'test:operation-001');
    const renewal = store.requestRenewal(account, 'RUB', { units: 3000, days: 30 });
    store.reserveRenewal(renewal.id, 'P'.repeat(16));
    if (!executing) store.settleRenewal(renewal.id, 'uncertain');
    return { store, account, other, id: renewal.id, now: () => clock, advance: (milliseconds = delay) => { clock += milliseconds; } };
}
const valueFor = (state, outcome = 'refunded') => ({ ...state.store.recoveryCase(state.id), outcome, note: proof });

test('manual reconciliation defaults off and refuses unsafe timing configuration', () => {
    const state = fixture({ enabled: false });
    try {
        assert.throws(() => state.store.recoveryCases(), /DISABLED/);
        assert.throws(() => state.store.reconcileRenewal(state.id, { outcome: 'refunded', note: proof }), /DISABLED/);
        assert.equal(state.store.account(state.account).balances.RUB, 7000);
    } finally { state.store.close(); }
    for (const reviewDelayMs of [0, 299999, 86400001, NaN]) assert.throws(() => createBusinessStore({ filename: ':memory:', reviewDelayMs }));
    const env = { PORTAL_PUBLIC_ORIGIN: 'http://localhost:8787', REMNAWAVE_BASE_URL: 'https://panel.example.invalid' };
    assert.equal(validateBusinessEnv(env), true);
    assert.throws(() => validateBusinessEnv({ ...env, BILLING_RECONCILIATION_ENABLED: 'true' }));
    assert.equal(validateBusinessEnv({ ...env, BILLING_MANUAL_ENABLED: 'true', BILLING_RECONCILIATION_ENABLED: 'true', BILLING_REVIEW_DELAY_SECONDS: '300' }), true);
});

for (const outcome of ['done', 'refunded']) test(`manual ${outcome} is delayed, atomic, audited, isolated and cannot settle twice`, () => {
    const state = fixture();
    try {
        const value = valueFor(state, outcome);
        assert.throws(() => state.store.reconcileRenewal(state.id, value), /NOT_READY/);
        assert.throws(() => state.store.requestRenewal(state.account, 'RUB', { units: 1000, days: 7 }), /PENDING/);
        state.advance();
        assert.deepEqual(state.store.reconcileRenewal(state.id, value), { settled: true, outcome });
        assert.equal(state.store.account(state.account).balances.RUB, outcome === 'done' ? 7000 : 10000);
        assert.equal(state.store.account(state.other).balances.RUB, 0);
        assert.deepEqual(state.store.renewals(state.other), []);
        assert.equal(state.store.renewals(state.account)[0].state, outcome === 'done' ? 'done' : 'rejected');
        assert.throws(() => state.store.reconcileRenewal(state.id, value));
        assert.throws(() => state.store.settleRenewal(state.id, 'rejected'));
        assert.equal(state.store.billingHistory().filter(entry => entry.operation === 'reconciliation').length, 1);
        assert.ok(!JSON.stringify(state.store.billingHistory()).includes('example.invalid'));
    } finally { state.store.close(); }
});

test('a changed state, proposal, backwards clock or secret-bearing proof cannot refund a reserve', () => {
    const state = fixture({ executing: true });
    try {
        const value = valueFor(state);
        state.store.settleRenewal(state.id, 'uncertain'); state.advance();
        assert.throws(() => state.store.reconcileRenewal(state.id, value), /NOT_READY/);
        const current = valueFor(state);
        assert.throws(() => state.store.reconcileRenewal(state.id, { ...current, proposal: 'Q'.repeat(16) }));
        for (const note of ['', 'tiny', 'https://example.invalid/private', 'a'.repeat(201), 'строка\nс переносом']) assert.throws(() => state.store.reconcileRenewal(state.id, { ...current, note }));
        state.advance(-delay - 1);
        assert.throws(() => state.store.reconcileRenewal(state.id, current), /NOT_READY/);
        assert.equal(state.store.account(state.account).balances.RUB, 7000);
    } finally { state.store.close(); }
});

test('legacy executing rows get a fresh quarantine and the deadline persists across reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'panel-billing-test-'));
    const filename = join(directory, 'business.sqlite');
    const state = fixture({ filename, executing: true });
    let reopened;
    try {
        state.store.close();
        const legacy = new DatabaseSync(filename); legacy.exec('DROP TABLE renewal_clock'); legacy.close();
        let clock = start + 86400000;
        reopened = createBusinessStore({ filename, reconciliationEnabled: true, reviewDelayMs: delay, now: () => clock });
        assert.equal(reopened.recoveryCase(state.id).readyAt, clock + delay);
        reopened.close(); reopened = undefined;
        clock += delay;
        reopened = createBusinessStore({ filename, reconciliationEnabled: true, reviewDelayMs: delay, now: () => clock });
        const item = reopened.recoveryCase(state.id);
        assert.deepEqual(reopened.reconcileRenewal(state.id, { ...item, outcome: 'refunded', note: proof }), { settled: true, outcome: 'refunded' });
    } finally {
        reopened?.close();
        for (const suffix of ['', '-wal', '-shm']) rmSync(filename + suffix, { force: true });
        rmdirSync(directory);
    }
});

async function apiFixture(store, enabled) {
    const handle = createBillingAdministration({ store, enabled });
    const server = createServer(async (incoming, outgoing) => { if (!await handle(incoming, outgoing)) outgoing.writeHead(404).end(); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        call: (path, value, options = {}) => new Promise((resolve, reject) => {
            const connection = request({ hostname: '127.0.0.1', port: server.address().port, method: value === undefined ? 'GET' : 'POST', path, headers: { 'Content-Type': 'application/json', ...options.headers } }, response => {
                let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, value: text ? JSON.parse(text) : {} }));
            }); connection.on('error', reject); connection.end(value === undefined ? undefined : JSON.stringify(value));
        }),
        close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
    };
}

test('private billing API gates every new path and validates a stale/repeated mutation independently', async () => {
    const state = fixture();
    const blocked = await apiFixture(state.store, false);
    const api = await apiFixture(state.store, true);
    try {
        assert.equal((await blocked.call('/recovery')).status, 400);
        const value = valueFor(state); state.advance();
        const body = { id: state.id, state: value.state, proposal: value.proposal, outcome: 'refunded', note: proof };
        assert.equal((await blocked.call('/renewal-reconcile', body)).status, 400);
        assert.equal((await api.call('/renewal-reconcile', { ...body, extra: true })).status, 400);
        assert.equal((await api.call('/renewal-reconcile', body, { headers: { 'Content-Type': 'text/plain' } })).status, 400);
        assert.equal((await api.call('/recovery/' + state.id)).value.id, state.id);
        assert.equal((await api.call('/renewal-reconcile', body)).status, 200);
        assert.equal((await api.call('/renewal-reconcile', body)).status, 400);
        assert.equal(state.store.account(state.account).balances.RUB, 10000);
    } finally { await blocked.close(); await api.close(); state.store.close(); }
});

function adminFixture(state, receipt = 'uncertain') {
    let mutations = 0;
    const call = async (path, value) => {
        if (path.startsWith('/recovery/')) return state.store.recoveryCase(path.slice(10));
        if (path === '/renewal-reconcile') { mutations++; return state.store.reconcileRenewal(value.id, value); }
        throw new Error('UNEXPECTED_PATH');
    };
    const handle = createBusinessAdmin({ actorId: actor, now: state.now, administration: { receipt: () => receipt, hasInFlight: () => false }, call });
    return { send: (text = '', data, allowedUserId = actor) => handle({ text, data, allowedUserId }), mutations: () => mutations };
}

test('Telegram financial review requires a sole-admin, fresh, explicit one-use callback; no panel write is called', async () => {
    const state = fixture(); const admin = adminFixture(state);
    try {
        state.advance();
        const preview = await admin.send(`сверка ${state.id} возврат ${proof}`);
        const key = preview.reply_markup.inline_keyboard[0][0].callback_data;
        assert.ok(key.startsWith('rv:')); assert.equal(admin.mutations(), 0);
        assert.equal(await admin.send('', key, actor + 1), null);
        assert.match((await admin.send('', key)).text, /Сверка зафиксирована/);
        assert.match((await admin.send('', key)).text, /использовано/);
        assert.equal(admin.mutations(), 1);
        assert.equal(state.store.account(state.account).balances.RUB, 10000);
    } finally { state.store.close(); }
});

for (const mode of ['timeout', 'clock', 'known-success']) test(`unsafe financial confirmation cannot change money: ${mode}`, async () => {
    const state = fixture(); const admin = adminFixture(state, mode === 'known-success' ? 'done' : 'uncertain');
    try {
        state.advance();
        const preview = await admin.send(`сверка ${state.id} возврат ${proof}`);
        if (mode === 'known-success') assert.match(preview.text, /запрещён/);
        else {
            state.advance(mode === 'timeout' ? 180000 : -1);
            assert.match((await admin.send('', preview.reply_markup.inline_keyboard[0][0].callback_data)).text, /устарело/);
        }
        assert.equal(admin.mutations(), 0);
        assert.equal(state.store.account(state.account).balances.RUB, 7000);
    } finally { state.store.close(); }
});
