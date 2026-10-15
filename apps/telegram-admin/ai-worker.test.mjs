import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { createIntentStore } from './intent-store.mjs';
import { createBudgetedIntent } from './budgeted-intent.mjs';
import { createClassifierClient } from './ai-client.mjs';
import { createClassifierServer } from './ai-worker.mjs';
import { classifierArguments, decodeClassifierOutput, guardClassifierEvent, createCodexClassifier, codexVersion, disabledFeatures } from './codex-classifier.mjs';
import { verifyClassifierCli } from './verify-ai-cli.mjs';

const start = Date.UTC(2026, 9, 15, 12);
const encoded = (intent = { action: 'expiring', days: 7 }, usage = { input_tokens: 500, cached_input_tokens: 100, output_tokens: 30 }) => [
    { type: 'thread.started', thread_id: 'synthetic' }, { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(intent) } }, { type: 'turn.completed', usage },
].map(value => JSON.stringify(value)).join('\n');

test('classifier arguments pin a small model, short replacement instructions, subscription auth and disabled integrations', () => {
    const args = classifierArguments();
    assert.equal(codexVersion, '0.162.1');
    assert.ok(args.includes('gpt-6-luna'));
    for (const feature of disabledFeatures) assert.ok(args.some((value, index) => value === '--disable' && args[index + 1] === feature));
    for (const flag of ['--ephemeral', '--ignore-user-config', '--json', '--output-schema', 'forced_login_method="chatgpt"', 'model_reasoning_effort="low"', 'mcp_servers={}', 'web_search="disabled"']) assert.ok(args.includes(flag));
    assert.ok(args.some(value => value.startsWith('model_instructions_file=')));
    assert.ok(!JSON.stringify(args).includes('panel_api_token'));
});

test('strict JSONL result accepts only a read intent and safe numeric usage', () => {
    const result = decodeClassifierOutput(encoded());
    assert.deepEqual(result.intent, { action: 'expiring', days: 7 });
    assert.deepEqual(result.usage, { inputTokens: 500, cachedInputTokens: 100, outputTokens: 30 });
    for (const raw of ['{}', encoded({ action: 'delete_user', days: 3 }), encoded({ action: 'stats', days: 3, url: 'https://example.invalid' }), encoded().replace('turn.completed', 'turn.failed'), encoded() + '\n' + encoded()]) assert.throws(() => decodeClassifierOutput(raw));
});

test('tool events are refused as soon as a complete event arrives', () => {
    for (const type of ['command_execution', 'mcp_tool_call', 'web_search', 'file_change', 'function_call']) {
        const line = JSON.stringify({ type: 'item.started', item: { type } });
        assert.throws(() => guardClassifierEvent(line), /AI_TOOL_ATTEMPT/);
        assert.throws(() => decodeClassifierOutput(line + '\n' + encoded()), /AI_TOOL_ATTEMPT/);
    }
});

test('missing, malformed or unexpectedly large usage triggers the post-call guard', () => {
    for (const usage of [null, {}, { input_tokens: -1, output_tokens: 2 }, { input_tokens: 8001, output_tokens: 1 }, { input_tokens: 1, output_tokens: 1025 }, { input_tokens: 5, output_tokens: 1, cached_input_tokens: 6 }]) assert.throws(() => decodeClassifierOutput(encoded(undefined, usage)), /AI_USAGE_GUARD/);
});

test('classifier passes only the question and returns no model-generated report', async () => {
    const calls = [];
    const usage = [];
    const classify = createCodexClassifier({ run: async value => { calls.push(value); return encoded(); }, onUsage: value => usage.push(value) });
    assert.deepEqual(await classify('Кто скоро останется без подписки за неделю?'), { action: 'expiring', days: 7 });
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].args.includes('Кто скоро останется без подписки за неделю?'));
    assert.match(calls[0].input, /Untrusted administrator question/);
    assert.equal(usage.length, 1);
    await assert.rejects(classify('https://example.invalid/private'), /AI_TEXT_REJECTED/);
    assert.equal(calls.length, 1);
});

test('CLI preflight checks the exact release, disabled features and ChatGPT login without inference', () => {
    const calls = [];
    const run = args => {
        calls.push(args);
        if (args.includes('--version')) return { status: 0, stdout: `codex-cli ${codexVersion}\n` };
        if (args.includes('features')) return { status: 0, stdout: disabledFeatures.map(feature => `${feature} stable false`).join('\n') + '\nunified_exec stable true' };
        if (args.includes('--help')) return { status: 0, stdout: '--json --ephemeral --output-schema --ignore-user-config' };
        return { status: 0, stdout: '', stderr: 'Logged in using ChatGPT' };
    };
    verifyClassifierCli({ run });
    assert.equal(calls.length, 4);
    assert.ok(calls.every(args => !args.includes('-')));
    assert.throws(() => verifyClassifierCli({ run: () => ({ status: 0, stdout: 'codex-cli other' }) }), /VERSION_MISMATCH/);
    assert.throws(() => verifyClassifierCli({ run: args => { const result = run(args); if (args.includes('features')) result.stdout = result.stdout.replace('shell_tool stable false', 'shell_tool stable true'); return result; } }), /FEATURES_UNAVAILABLE/);
    assert.throws(() => verifyClassifierCli({ run: args => args.includes('login') ? { status: 0, stderr: 'Logged in using an API key' } : run(args) }), /CHATGPT_LOGIN_REQUIRED/);
});

async function bridgeFixture(options = {}) {
    let clock = start;
    let calls = 0;
    let paused = false;
    const directory = mkdtempSync(join(tmpdir(), 'classifier-'));
    const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\classifier-${randomUUID()}` : join(directory, 'classifier.sock');
    const store = createIntentStore({ filename: join(directory, 'quota.sqlite'), dailyLimit: options.dailyLimit ?? 10, now: () => clock });
    const events = [];
    const server = createClassifierServer({ store, paused: () => paused, pause: () => { paused = true; }, classify: async (text, signal) => { calls++; return options.classify ? options.classify(text, signal) : { action: 'stats', days: 3 }; }, onEvent: value => events.push(value) });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    return { socketPath, store, events, calls: () => calls, paused: () => paused, advance: () => { clock += 60000; }, close: async () => {
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true });
    } };
}

test('private socket bridge enforces an independent persistent daily quota', async () => {
    const state = await bridgeFixture({ dailyLimit: 1 });
    try {
        const classify = createClassifierClient({ socketPath: state.socketPath });
        assert.deepEqual(await classify('Synthetic status'), { action: 'stats', days: 3 });
        state.advance();
        await assert.rejects(classify('Another status'), /AI_DAILY_LIMIT/);
        assert.equal(state.calls(), 1);
        assert.equal(state.store.status().used, 1);
        assert.ok(!JSON.stringify(state.events).includes('Synthetic'));
    } finally { await state.close(); }
});

test('worker counts failures without retry and blocks model calls after a usage guard', async () => {
    const state = await bridgeFixture({ classify: async () => { throw new Error('AI_USAGE_GUARD'); } });
    try {
        const classify = createClassifierClient({ socketPath: state.socketPath });
        await assert.rejects(classify('Synthetic question'));
        state.advance();
        await assert.rejects(classify('Another question'));
        assert.equal(state.calls(), 1);
        assert.equal(state.paused(), true);
        assert.equal(state.store.status().used, 1);
    } finally { await state.close(); }
});

test('unsupported socket endpoints and invalid questions cannot reserve budget', async () => {
    const state = await bridgeFixture();
    try {
        await new Promise((resolve, reject) => {
            const connection = request({ socketPath: state.socketPath, path: '/arbitrary', method: 'POST' }, response => { response.resume(); response.on('end', resolve); });
            connection.once('error', reject); connection.end('{}');
        });
        const classify = createClassifierClient({ socketPath: state.socketPath });
        assert.throws(() => classify('https://example.invalid/private'), /AI_TEXT_REJECTED/);
        assert.equal(state.calls(), 0);
        assert.equal(state.store.status().used, 0);
    } finally { await state.close(); }
});

test('repeated learned questions cross the real socket once, then use the local cache', async () => {
    const state = await bridgeFixture();
    const store = createIntentStore({ filename: ':memory:', now: () => start });
    try {
        const classify = createBudgetedIntent({ store, classify: createClassifierClient({ socketPath: state.socketPath }) });
        await classify('Synthetic report please'); await classify(' SYNTHETIC REPORT PLEASE? ');
        assert.equal(state.calls(), 1);
        assert.equal(store.status().used, 1);
        assert.equal(state.store.status().used, 1);
        await classify('покажи статистику');
        assert.equal(state.calls(), 1);
    } finally { store.close(); await state.close(); }
});

test('concurrent requests cannot queue another model call or consume another worker reservation', async () => {
    let release;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const result = new Promise(resolve => { release = resolve; });
    const state = await bridgeFixture({ classify: async () => { started(); await result; return { action: 'stats', days: 3 }; } });
    try {
        const classify = createClassifierClient({ socketPath: state.socketPath });
        const first = classify('Synthetic first question');
        await ready;
        await assert.rejects(classify('Synthetic second question'), /AI_BUSY/);
        assert.equal(state.store.status().used, 1);
        assert.equal(state.calls(), 1);
        release(); await first;
    } finally { release(); await state.close(); }
});

test('disconnecting the owner request cancels classifier work without refund or retry', async () => {
    let started;
    let cancelled;
    const ready = new Promise(resolve => { started = resolve; });
    const stopped = new Promise(resolve => { cancelled = resolve; });
    const state = await bridgeFixture({ classify: async (_text, signal) => {
        started();
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => { cancelled(); reject(new Error('AI_UNAVAILABLE')); }, { once: true }));
    } });
    try {
        const controller = new AbortController();
        const classify = createClassifierClient({ socketPath: state.socketPath, signal: controller.signal });
        const failed = assert.rejects(classify('Synthetic question'), /AI_UNAVAILABLE/);
        await ready; controller.abort(); await failed; await stopped;
        assert.equal(state.calls(), 1);
        assert.equal(state.store.status().used, 1);
    } finally { await state.close(); }
});

test('AI deployment is opt-in and cannot mount Telegram or panel credentials', () => {
    const compose = readFileSync(new URL('./compose.ai.yaml', import.meta.url), 'utf8');
    const worker = compose.split('  ai:\n')[1];
    assert.ok(!/secrets:|telegram_bot_token|panel_api_token|\/var\/run\/docker|network_mode:|ports:|privileged:/.test(worker));
    assert.match(worker, /codex-auth:\/home\/node\/\.codex/);
    assert.match(worker, /ai-state:\/state/);
    const ignore = readFileSync(new URL('./Dockerfile.ai.dockerignore', import.meta.url), 'utf8');
    assert.ok(ignore.startsWith('**\n'));
    assert.ok(!ignore.includes('secrets/'));
    const base = readFileSync(new URL('./compose.yaml', import.meta.url), 'utf8');
    assert.match(base, /AI_ENABLED: "false"/);
    assert.ok(!base.includes('codex-auth'));
});
