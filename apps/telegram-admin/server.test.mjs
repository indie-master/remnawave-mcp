import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createConfiguredService } from './configured-service.mjs';
import { readRunOptions, readServerConfig } from './server-config.mjs';
import { runServerBot } from './server-loop.mjs';
import { TelegramError } from '../telegram-client/telegram-api.mjs';

const owner = 123456789;
const start = Date.UTC(2026, 9, 14, 15);
const incoming = (update_id, text = '/stats', from = owner) => ({ update_id, message: { text, date: start / 1000, chat: { id: from, type: 'private' }, from: { id: from, is_bot: false } } });

function fixture(batches = []) {
    let clock = start;
    const calls = [];
    const replies = [];
    const offsets = [];
    const saved = [];
    const events = [];
    let reads = 0;
    let beats = 0;
    const options = {
        allowedUserId: owner, botUsername: 'example_admin_bot', soleReceiverConfirmed: true, seconds: 60,
        now: () => clock, sleep: async () => {},
        saveOffset: offset => saved.push(offset), heartbeat: () => beats++, onEvent: event => events.push(event),
        api: {
            getMe: async () => { calls.push('getMe'); return { is_bot: true, username: 'example_admin_bot' }; },
            getWebhookInfo: async () => { calls.push('getWebhookInfo'); return { url: '' }; },
            getUpdates: async offset => {
                calls.push('getUpdates'); offsets.push(offset);
                if (!batches.length) { clock += 61000; return []; }
                const next = batches.shift();
                if (next instanceof Error) throw next;
                return next;
            },
            sendReply: async payload => { replies.push(payload); },
            answerCallback: async () => {},
        },
        service: {
            stats: async () => { reads++; return { totalUsers: 10, usersOnline: 2, observedAt: new Date(clock).toISOString() }; },
        },
    };
    return { options, calls, replies, offsets, saved, events, reads: () => reads, beats: () => beats };
}

test('server launch requires explicit confirmation and a bounded or explicitly continuous mode', () => {
    assert.throws(() => readRunOptions([]), /NOT_AUTHORIZED/);
    assert.throws(() => readRunOptions(['--live']), /NOT_AUTHORIZED/);
    const approved = ['--live', '--confirm-sole-receiver'];
    assert.equal(readRunOptions(approved).seconds, 900);
    assert.equal(readRunOptions([...approved, '--continuous']).continuous, true);
    for (const args of [['--seconds', '0'], ['--seconds', '901'], ['--seconds'], ['--continuous', '--seconds', '60'], ['--enable-ai'], ['--live']])
        assert.throws(() => readRunOptions([...approved, ...args]), /NOT_AUTHORIZED/);
});

test('server configuration accepts no AI credentials and rejects incomplete or ambiguous input', () => {
    const env = { TELEGRAM_ADMIN_ID: String(owner), BOT_USERNAME: 'example_admin_bot', REMNAWAVE_BASE_URL: 'https://panel.example.invalid', PANEL_USERS_READ_ENABLED: 'true', AI_ENABLED: 'false' };
    assert.equal(readServerConfig(env).usersEnabled, true);
    assert.equal(readServerConfig(env).panelTokenFile, '/run/secrets/panel_api_token');
    for (const override of [{ TELEGRAM_ADMIN_ID: '' }, { TELEGRAM_ADMIN_ID: '1e8' }, { BOT_USERNAME: '@example_admin_bot' }, { AI_ENABLED: 'true' }, { PANEL_USERS_READ_ENABLED: 'yes' }, { REMNAWAVE_API_TOKEN_FILE: 'relative.txt' }])
        assert.throws(() => readServerConfig({ ...env, ...override }));
});

test('configured service validates HTTPS before reading a token', () => {
    for (const baseUrl of ['http://panel.example.invalid', 'https://user:pass@panel.example.invalid', 'https://panel.example.invalid/path', 'https://panel.example.invalid?query=1', 'not-a-url'])
        assert.throws(() => createConfiguredService({ baseUrl, tokenFile: '/does-not-exist' }), /INVALID_LOCAL_CONFIGURATION/);
    const service = createConfiguredService({ baseUrl: 'https://panel.example.invalid', tokenFile: '/does-not-exist' });
    assert.equal(service.bypassProxyHost, 'panel.example.invalid');
});

test('server refusal happens before Telegram or panel access', async () => {
    const state = fixture();
    await assert.rejects(runServerBot({ ...state.options, soleReceiverConfirmed: false }), /NOT_AUTHORIZED/);
    assert.equal(state.calls.length, 0);
    assert.equal(state.reads(), 0);
});

test('webhook and wrong identity are blocked without polling or changing bot configuration', async () => {
    for (const kind of ['webhook', 'identity']) {
        const state = fixture();
        if (kind === 'webhook') state.options.api.getWebhookInfo = async () => ({ url: 'https://example.invalid/FAKE_SECRET' });
        else state.options.api.getMe = async () => ({ is_bot: true, username: 'other_bot' });
        const result = await runServerBot(state.options);
        assert.equal(result.status, 'blocked');
        assert.ok(!state.calls.includes('getUpdates'));
        assert.equal(state.replies.length, 0);
        assert.ok(!JSON.stringify(result).includes('FAKE_SECRET'));
    }
});

test('idle server does not poll panel data and sends explicit start and time-limit notices', async () => {
    const state = fixture();
    const result = await runServerBot(state.options);
    assert.equal(result.reason, 'TIME_LIMIT');
    assert.equal(state.reads(), 0);
    assert.equal(state.replies.length, 2);
    assert.match(state.replies[0].text, /Тест бота начался/);
    assert.match(state.replies[1].text, /Тест завершён по таймеру/);
    assert.ok(state.replies.every(reply => reply.chat_id === owner && reply.protect_content === true));
    assert.ok(state.beats() > 0);
});

test('server restores and persists only positive offsets, ignores duplicates and foreign users', async () => {
    const state = fixture([[incoming(4), incoming(5, '/stats', owner + 1), incoming(6)]]);
    state.options.loadOffset = () => 5;
    const result = await runServerBot(state.options);
    assert.equal(result.reason, 'TIME_LIMIT');
    assert.deepEqual(state.offsets, [5, 7]);
    assert.deepEqual(state.saved, [6, 7]);
    assert.equal(state.reads(), 1);
    assert.ok(state.events.some(event => event.action === 'stats' && event.ok));
    assert.ok(!JSON.stringify(state.events).includes(String(owner)));
});

test('invalid saved state is blocked instead of discarding the incoming queue', async () => {
    for (const offset of [-1, '5', null]) {
        const state = fixture();
        state.options.loadOffset = () => offset;
        const result = await runServerBot(state.options);
        assert.equal(result.reason, 'INVALID_STATE');
        assert.equal(state.calls.length, 0);
    }
});

test('receiver conflict stops without retry or changing the webhook', async () => {
    const state = fixture([new TelegramError('RECEIVER_CONFLICT')]);
    const result = await runServerBot(state.options);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'RECEIVER_CONFLICT');
    assert.equal(state.offsets.length, 1);
    assert.equal(state.reads(), 0);
});

test('network retry uses bounded backoff without revealing exception content', async () => {
    const state = fixture([new TelegramError('NETWORK_FAILED'), new TelegramError('NETWORK_FAILED'), []]);
    const delays = [];
    state.options.sleep = async delay => delays.push(delay);
    const result = await runServerBot(state.options);
    assert.equal(result.reason, 'TIME_LIMIT');
    assert.deepEqual(delays.slice(0, 2), [1000, 2000]);
    assert.equal(state.reads(), 0);
    const broken = fixture([new Error('FAKE_SECRET https://private.example.invalid')]);
    assert.ok(!JSON.stringify(await runServerBot(broken.options)).includes('FAKE_SECRET'));
});

test('long-running mode is explicit and stops on cancellation with an owner notification', async () => {
    const state = fixture();
    const controller = new AbortController();
    state.options.api.getUpdates = async () => { controller.abort(); return []; };
    const result = await runServerBot({ ...state.options, continuous: true, signal: controller.signal });
    assert.equal(result.reason, 'STOP_REQUESTED');
    assert.match(state.replies[0].text, /запущен на сервере/);
    assert.equal(state.replies.length, 2);
});

test('panel failures have safe per-action diagnostics and never become zero counts', async () => {
    const state = fixture([[incoming(1)]]);
    state.options.service.stats = async () => { throw new Error('FAKE_SECRET private-address'); };
    await runServerBot(state.options);
    assert.match(state.replies[1].text, /Данные недоступны/);
    assert.deepEqual(state.events[0], { event: 'report', action: 'stats', source: 'direct', ok: false, code: 'PANEL_READ_UNAVAILABLE' });
    assert.ok(!JSON.stringify(state.events).includes('FAKE_SECRET'));
});

test('server menu describes disabled AI honestly and free text never reads the panel', async () => {
    const state = fixture([[incoming(1, '/menu'), incoming(2, 'У кого истекает подписка в ближайшую неделю?')]]);
    await runServerBot(state.options);
    assert.match(state.replies[1].text, /ИИ в этом запуске отключён/);
    assert.match(state.replies[2].text, /ИИ ещё не подключён/);
    assert.equal(state.reads(), 0);
});

test('Docker build uses an explicit source allowlist and no private workspace configuration', () => {
    const dockerfile = readFileSync(new URL('./Dockerfile', import.meta.url), 'utf8');
    const ignore = readFileSync(new URL('./Dockerfile.dockerignore', import.meta.url), 'utf8');
    const compose = readFileSync(new URL('./compose.yaml', import.meta.url), 'utf8');
    assert.ok(ignore.startsWith('**\n'));
    assert.ok(!ignore.includes('!secrets/'));
    assert.ok(!ignore.includes('!apps/telegram-admin/secrets/'));
    assert.ok(!dockerfile.includes('COPY .'));
    assert.ok(!dockerfile.includes('connection.local.json'));
    assert.match(compose, /read_only: true/);
    assert.match(compose, /cap_drop: \["ALL"\]/);
    assert.ok(!compose.includes('ports:'));
    assert.ok(!compose.includes('docker.sock'));
    assert.ok(!compose.includes('network_mode:'));
    assert.match(compose, /AI_ENABLED: "false"/);
    assert.ok(compose.includes('/app/apps/telegram-admin/healthcheck.mjs'));
});
