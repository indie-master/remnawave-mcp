import { createServer } from 'node:http';
import { validateIntent } from './intent.mjs';
import { normalizeQuestion } from './intent-store.mjs';

export function createClassifierServer({ store, classify, paused = () => false, pause = () => {}, onEvent = () => {} }) {
    let busy = false;
    const server = createServer(async (request, response) => {
        const send = (status, value) => { if (!response.destroyed) response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value)); };
        if (request.method === 'GET' && request.url === '/health') { send(paused() ? 503 : 200, { ready: !paused() }); return; }
        if (paused()) { send(503, { code: 'AI_PAUSED' }); request.resume(); return; }
        if (request.method !== 'POST' || request.url !== '/classify' || request.headers['content-type'] !== 'application/json') { send(503, { code: 'AI_UNAVAILABLE' }); request.resume(); return; }
        if (busy) { send(429, { code: 'AI_BUSY' }); request.resume(); return; }
        busy = true;
        const controller = new AbortController();
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
            if (!value || Object.keys(value).join(',') !== 'question') throw new Error('AI_TEXT_REJECTED');
            normalizeQuestion(value.question);
            if (controller.signal.aborted || paused()) throw new Error('AI_UNAVAILABLE');
            store.reserve();
            const intent = validateIntent(await classify(value.question, controller.signal));
            send(200, intent);
            onEvent({ event: 'classification', ok: true });
        } catch (error) {
            if (['AI_TOOL_ATTEMPT', 'AI_USAGE_GUARD'].includes(error?.message)) pause();
            const quotaError = ['AI_DAILY_LIMIT', 'AI_RATE_LIMIT', 'AI_BUSY'].includes(error?.message);
            const code = quotaError ? error.message : 'AI_UNAVAILABLE';
            send(quotaError ? 429 : 503, { code });
            onEvent({ event: 'classification', ok: false, code });
        } finally { busy = false; }
    });
    server.headersTimeout = 5000;
    server.requestTimeout = 10000;
    server.timeout = 55000;
    server.maxConnections = 4;
    server.on('clientError', (_error, socket) => socket.destroy());
    return server;
}
