import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createIntentStore } from './intent-store.mjs';
import { createCodexClassifier } from './codex-classifier.mjs';
import { verifyClassifierCli } from './verify-ai-cli.mjs';
import { createClassifierServer } from './ai-worker.mjs';
import { classifierSocket } from './ai-client.mjs';
import { createRunSafety, waitForOperator } from './run-safety.mjs';

const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const event = value => process.stdout.write(JSON.stringify({ observedAt: new Date().toISOString(), ...value }) + '\n');
let store;
let server;
let safety;
let heartbeatTimer;
let ownsSocket = false;
try {
    if (process.argv.slice(2).join(' ') !== '--serve --confirm-subscription-usage' || process.env.AI_ENABLED !== 'true') throw new Error('AI_START_NOT_AUTHORIZED');
    process.umask(0o077);
    mkdirSync('/state', { recursive: true, mode: 0o700 });
    safety = createRunSafety({ directory: '/state' });
    const pauseFile = '/state/classifier-paused';
    const paused = () => safety.read().mode === 'paused' || existsSync(pauseFile);
    const heartbeat = () => writeFileSync('/state/heartbeat.json', JSON.stringify({ observedAt: Date.now(), phase: paused() ? 'paused' : 'ready' }), { mode: 0o600 });
    if (paused()) {
        heartbeat(); event({ status: 'paused', externalCalls: false });
        await waitForOperator({ signal: controller.signal, heartbeat });
    } else {
        verifyClassifierCli();
        store = createIntentStore({ filename: '/state/ai-quota.sqlite' });
        server = createClassifierServer({ store, paused, pause: () => writeFileSync(pauseFile, 'AI_GUARD_TRIGGERED\n', { mode: 0o600 }), classify: (text, signal) => createCodexClassifier({ signal, onUsage: usage => event({ event: 'usage', ...usage }) })(text), onEvent: event });
        mkdirSync('/bridge', { recursive: true, mode: 0o700 });
        if (existsSync(classifierSocket)) {
            if (!statSync(classifierSocket).isSocket()) throw new Error('AI_SOCKET_UNAVAILABLE');
            unlinkSync(classifierSocket);
        }
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(classifierSocket, resolve); });
        ownsSocket = true;
        chmodSync(classifierSocket, 0o600);
        heartbeat(); heartbeatTimer = setInterval(heartbeat, 30000);
        event({ ready: true, subscriptionAi: true, dailyLimit: 10, customerSending: false, model: 'gpt-6-luna' });
        await new Promise(resolve => {
            const end = () => { server.close(); server.closeAllConnections(); resolve(); };
            if (controller.signal.aborted) end();
            else controller.signal.addEventListener('abort', end, { once: true });
        });
    }
} catch {
    try { safety?.record({ status: 'failed', startedAt: null, stoppedAt: new Date().toISOString() }); } catch {}
    process.stderr.write('AI worker unavailable. Check its pinned CLI, separate ChatGPT sign-in and private state. No credentials were printed.\n');
    process.exitCode = 2;
} finally {
    clearInterval(heartbeatTimer);
    controller.abort();
    server?.closeAllConnections();
    server?.close();
    if (ownsSocket) { try { unlinkSync(classifierSocket); } catch {} }
    store?.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
}
