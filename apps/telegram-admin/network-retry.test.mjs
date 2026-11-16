import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadRetry } from './network-retry.mjs';
import { runServerBot } from './server-loop.mjs';
import { createRunSafety } from './run-safety.mjs';
import { createTelegramApi, TelegramError } from '../telegram-client/telegram-api.mjs';

test('read retries respect Telegram throttling, heartbeat during a long delay and abort without a new request', async () => {
    const controller = new AbortController(); const delays = []; const beats = []; let calls = 0;
    const read = createReadRetry({ signal: controller.signal, sleep: async delay => { delays.push(delay); if (delays.length === 3) controller.abort(); }, heartbeat: phase => beats.push(phase) });
    await assert.rejects(read(async () => { calls++; throw Object.assign(new Error('private'), { code: 'TELEGRAM_RATE_LIMIT', retryAfter: 120 }); }, 'poll'), /STOP_REQUESTED/);
    assert.equal(calls, 1); assert.deepEqual(delays, [30000, 30000, 30000]); assert.deepEqual(beats, ['reconnecting', 'reconnecting', 'reconnecting']);
});

test('receiver conflicts, authentication failures and invalid state never enter network retry', async () => {
    for (const code of ['RECEIVER_CONFLICT', 'BOT_IDENTITY_MISMATCH', 'INVALID_STATE', 'TELEGRAM_REQUEST_FAILED', 'CUSTOMER_UNAVAILABLE']) {
        let calls = 0; let sleeps = 0;
        const read = createReadRetry({ sleep: async () => sleeps++ });
        await assert.rejects(read(async () => { calls++; throw Object.assign(new Error('private'), { code }); }, 'get_me'), error => error.code === code);
        assert.equal(calls, 1); assert.equal(sleeps, 0);
    }
});

test('continuous admin startup and polling survive network outages without duplicate replies, panel requests or AI', async () => {
    const controller = new AbortController(); let starts = 0; let polls = 0; let replies = 0; const phases = [];
    const result = await runServerBot({ allowedUserId: 123456789, botUsername: 'example_admin_bot', soleReceiverConfirmed: true, continuous: true, signal: controller.signal, service: {}, sleep: async () => {}, heartbeat: phase => phases.push(phase), api: {
        getMe: async () => { if (starts++ < 7) throw new TelegramError('NETWORK_FAILED'); return { is_bot: true, username: 'example_admin_bot' }; }, getWebhookInfo: async () => ({ url: '' }),
        sendReply: async () => { replies++; }, getUpdates: async () => { if (polls++ < 9) throw new TelegramError('NETWORK_FAILED'); controller.abort(); return []; },
    } });
    assert.equal(result.status, 'stopped'); assert.equal(starts, 8); assert.equal(polls, 10); assert.equal(replies, 2); assert.ok(phases.includes('reconnecting'));
});

test('uncertain startup notification is attempted once and does not stop normal command reception', async () => {
    const controller = new AbortController(); let notices = 0; let polls = 0; let reads = 0; const sent = [];
    const result = await runServerBot({ allowedUserId: 123456789, botUsername: 'example_admin_bot', soleReceiverConfirmed: true, continuous: true, signal: controller.signal, sleep: async () => {},
        service: { stats: async () => { reads++; return { totalUsers: 1, usersOnline: 0, observedAt: new Date().toISOString() }; } }, api: {
            getMe: async () => ({ is_bot: true, username: 'example_admin_bot' }), getWebhookInfo: async () => ({ url: '' }),
            sendReply: async value => { if (value.text.includes('Бот запущен')) { notices++; throw new TelegramError('NETWORK_FAILED'); } sent.push(value); },
            getUpdates: async () => { if (polls++) { controller.abort(); return []; } return [{ update_id: 1, message: { date: Date.now() / 1000 | 0, text: '/stats', from: { id: 123456789, is_bot: false }, chat: { id: 123456789, type: 'private' } } }]; },
        } });
    assert.equal(result.status, 'stopped'); assert.equal(notices, 1); assert.equal(reads, 1); assert.ok(sent.some(value => value.text.includes('Статистика')));
});

test('temporary HTTP failures are distinct from invalid credentials and never expose Telegram error bodies', async () => {
    for (const [status, content, expected] of [[502, 'PRIVATE_GATEWAY_PAGE', 'TELEGRAM_TEMPORARY_UNAVAILABLE'], [429, JSON.stringify({ parameters: { retry_after: 120 } }), 'TELEGRAM_RATE_LIMIT'], [401, JSON.stringify({ ok: false, description: 'PRIVATE_TOKEN' }), 'TELEGRAM_REQUEST_FAILED']]) {
        const api = createTelegramApi({ token: '123456789:' + 'a'.repeat(35), allowedUserId: 123456789, fetchImpl: async () => new Response(content, { status }) });
        await assert.rejects(api.getMe(), error => error.code === expected && !JSON.stringify(error).includes('PRIVATE'));
    }
});

test('persistent startup guard records a fixed cause and phase without weakening its explicit recovery requirement', () => {
    const directory = mkdtempSync(join(tmpdir(), 'receiver-diagnostics-')); let clock = Date.now();
    try {
        const safety = createRunSafety({ directory, now: () => clock });
        for (let index = 0; index < 5; index++) { safety.record({ status: 'failed', startedAt: null, stoppedAt: new Date(clock).toISOString(), cause: 'TELEGRAM_REQUEST_FAILED', phase: 'get_me' }); clock += 1000; }
        const state = createRunSafety({ directory }).read();
        assert.equal(state.mode, 'paused'); assert.equal(state.lastCause, 'TELEGRAM_REQUEST_FAILED'); assert.equal(state.lastPhase, 'get_me');
        assert.equal(safety.record({ status: 'stopped' }).mode, 'paused');
        safety.acknowledge(); assert.equal(safety.read().mode, 'active');
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a new admin process invalidates the previous ready heartbeat before validating configuration or reading credentials', () => {
    const directory = mkdtempSync(join(tmpdir(), 'receiver-heartbeat-'));
    try {
        writeFileSync(join(directory, 'heartbeat.json'), JSON.stringify({ observedAt: Date.now(), phase: 'ready' }));
        const child = spawnSync(process.execPath, [fileURLToPath(new URL('./start-server.mjs', import.meta.url)), '--live', '--confirm-sole-receiver', '--continuous'], { env: { ...process.env, BOT_STATE_DIRECTORY: directory, REMNAWAVE_BASE_URL: 'not-a-url' }, encoding: 'utf8', timeout: 10000 });
        assert.notEqual(child.status, 0); assert.equal(JSON.parse(readFileSync(join(directory, 'heartbeat.json'), 'utf8')).phase, 'starting');
        assert.ok(!child.stdout.includes('not-a-url')); assert.equal(createRunSafety({ directory }).read().failures, 1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
