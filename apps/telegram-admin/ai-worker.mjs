import { createServer } from 'node:http';
import { validateIntent } from './intent.mjs';
import { normalizeQuestion } from './intent-store.mjs';
import { classifierDiagnostic } from './codex-classifier.mjs';
import { validateSupportInput, validateSupportReply } from './support-policy.mjs';

export function createClassifierServer({ store, classify, support, paused = () => false, pause = () => {}, onEvent = () => {} }) {
    let busy = false;
    let failed = false;
    const isPaused = () => failed || paused();
    const server = createServer(async (request, response) => {
        const send = (status, value) => { if (!response.destroyed) response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value)); };
        if (request.method === 'GET' && request.url === '/usage') {
            try { send(200, store.status()); } catch { send(503, { code: 'AI_STATE_UNAVAILABLE' }); }
            return;
        }
        if (request.method === 'GET' && request.url === '/health') {
            if (isPaused()) send(503, { ready: false, code: 'AI_PAUSED' });
            else if (busy) send(429, { ready: false, code: 'AI_BUSY' });
            else send(200, { ready: true });
            return;
        }
        if (isPaused()) { send(503, { code: 'AI_PAUSED' }); request.resume(); return; }
        const supportRequest = request.url === '/support' && typeof support === 'function';
        if (request.method !== 'POST' || (!supportRequest && request.url !== '/classify') || request.headers['content-type'] !== 'application/json') { send(503, { code: 'AI_UNAVAILABLE' }); request.resume(); return; }
        if (busy) { send(429, { code: 'AI_BUSY' }); request.resume(); return; }
        busy = true;
        const controller = new AbortController();
        let attempted = false;
        response.once('close', () => { if (!response.writableEnded) controller.abort(); });
        try {
            const chunks = [];
            let size = 0;
            for await (const chunk of request) {
                size += chunk.length;
                if (size > 4096) { request.destroy(); throw new Error('AI_TEXT_REJECTED'); }
                chunks.push(chunk);
            }
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (supportRequest) validateSupportInput(value);
            else {
                if (!value || Object.keys(value).join(',') !== 'question') throw new Error('AI_TEXT_REJECTED');
                normalizeQuestion(value.question);
            }
            if (controller.signal.aborted || isPaused()) throw new Error('AI_UNAVAILABLE');
            store.reserve();
            attempted = true;
            const intent = supportRequest ? validateSupportReply(await support(value, controller.signal)) : validateIntent(await classify(value.question, controller.signal));
            send(200, intent);
            onEvent({ event: supportRequest ? 'support' : 'classification', ok: true });
        } catch (error) {
            let pausePersisted = false;
            if (attempted) {
                failed = true;
                try { pause(classifierDiagnostic(error)); pausePersisted = true; } catch {}
            }
            const quotaError = ['AI_DAILY_LIMIT', 'AI_RATE_LIMIT', 'AI_BUSY'].includes(error?.message);
            const code = quotaError ? error.message : 'AI_UNAVAILABLE';
            send(quotaError ? 429 : 503, { code });
            onEvent({ event: 'classification', ok: false, code, ...(attempted ? { paused: true, pausePersisted, ...classifierDiagnostic(error) } : {}) });
        } finally { busy = false; }
    });
    server.headersTimeout = 5000;
    server.requestTimeout = 10000;
    server.timeout = 55000;
    server.maxConnections = 4;
    server.on('clientError', (_error, socket) => socket.destroy());
    return server;
}
