import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { redactSupport } from './store.mjs';

export function createPortal({ store, support, origin, panelRead, billingEnabled = false, plans = {}, analyzeMedia, maxMediaBytes = 5242880, guides }) {
    const publicOrigin = new URL(origin);
    const local = publicOrigin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(publicOrigin.hostname);
    if ((!local && publicOrigin.protocol !== 'https:') || publicOrigin.pathname !== '/' || publicOrigin.username || publicOrigin.password || publicOrigin.search || publicOrigin.hash) throw new Error('INVALID_PORTAL_ORIGIN');
    const html = readFileSync(new URL('./portal.html', import.meta.url), 'utf8');
    let mediaBusy = false;
    const server = createServer(async (request, response) => {
        response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('X-Frame-Options', 'DENY');
        const send = (status, value) => { if (!response.destroyed) response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value)); };
        try {
            if (request.method === 'GET' && request.url === '/health') { send(200, { ready: true }); return; }
            if (request.headers.host !== publicOrigin.host) throw new Error('REQUEST_REJECTED');
            if (request.method === 'GET' && request.url === '/') {
                const nonce = randomBytes(18).toString('base64');
                response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html.replaceAll('__NONCE__', nonce)); return;
            }
            if (request.method === 'POST' && request.url === '/api/media') {
                if (!analyzeMedia || mediaBusy || request.headers.origin !== publicOrigin.origin || !['image/png', 'image/jpeg', 'video/mp4'].includes(request.headers['content-type'])) throw new Error('MEDIA_REJECTED');
                const token = request.headers.cookie?.match(/(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/)?.[1];
                const session = store.session(token);
                if (request.headers['x-csrf-token'] !== session.csrf) throw new Error('REQUEST_REJECTED');
                const permission = store.consumeMedia(session.account);
                mediaBusy = true;
                try {
                    const chunks = []; let size = 0;
                    for await (const chunk of request) { size += chunk.length; if (size > maxMediaBytes) { request.destroy(); throw new Error('MEDIA_REJECTED'); } chunks.push(chunk); }
                    const media = await analyzeMedia(Buffer.concat(chunks), request.headers['content-type']);
                    if (!media.relevant) { send(200, { reply: 'Поддерживаемое приложение не распознано. Вложение удалено и не передавалось ИИ.', source: 'ignored' }); return; }
                    store.queueMedia(session.account, `${permission.question.slice(0, 100)}. OCR: ${redactSupport(media.text).slice(0, 300)}`);
                    send(200, { reply: 'Текст извлечён локально и ожидает проверки администратора перед передачей ИИ. Исходное вложение удалено, бюджет модели не расходовался.', source: 'human', needsHuman: true });
                } finally { mediaBusy = false; }
                return;
            }
            let body = {};
            if (request.method === 'POST') {
                if (request.headers.origin !== publicOrigin.origin || request.headers['content-type'] !== 'application/json') throw new Error('REQUEST_REJECTED');
                const chunks = []; let bytes = 0;
                for await (const chunk of request) { bytes += chunk.length; if (bytes > 4096) { request.destroy(); throw new Error('REQUEST_REJECTED'); } chunks.push(chunk); }
                body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('REQUEST_REJECTED');
            }
            if (request.method === 'POST' && request.url === '/api/login') {
                if (Object.keys(body).sort().join(',') !== 'email,password') throw new Error('REQUEST_REJECTED');
                const session = store.login(body.email, body.password, request.socket.remoteAddress);
                response.setHeader('Set-Cookie', `session=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${local ? '' : '; Secure'}`);
                send(200, { csrf: session.csrf }); return;
            }
            const token = request.headers.cookie?.match(/(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/)?.[1];
            const session = store.session(token);
            if (request.method === 'POST' && request.headers['x-csrf-token'] !== session.csrf) throw new Error('REQUEST_REJECTED');
            if (request.method === 'GET' && request.url === '/api/account') { send(200, { ...store.account(session.account), csrf: session.csrf, payments: store.payments(session.account), history: store.history(session.account), features: { media: !!analyzeMedia, billing: billingEnabled } }); return; }
            if (request.method === 'GET' && request.url === '/api/guides') { send(200, guides?.list() ?? []); return; }
            if (request.method === 'GET' && /^\/api\/guides\/[a-z0-9_-]{1,40}$/.test(request.url) && guides) {
                const image = guides.image(request.url.split('/').at(-1)); response.writeHead(200, { 'Content-Type': image.type }).end(image.bytes); return;
            }
            if (request.method === 'GET' && request.url === '/api/subscription') {
                if (!panelRead) throw new Error('PANEL_UNAVAILABLE');
                const value = await panelRead(store.account(session.account).panelId);
                send(200, value); return;
            }
            if (request.method === 'POST' && request.url === '/api/logout') { store.logout(token); response.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); send(200, { ok: true }); return; }
            if (request.method === 'POST' && request.url === '/api/payments' && billingEnabled) {
                if (Object.keys(body).sort().join(',') !== 'amount,currency' || !['RUB', 'USDT'].includes(body.currency) || typeof body.amount !== 'string') throw new Error('INVALID_PAYMENT');
                const precision = body.currency === 'RUB' ? 2 : 6;
                if (!new RegExp(`^[1-9]\\d{0,5}(?:\\.\\d{1,${precision}})?$`).test(body.amount)) throw new Error('INVALID_PAYMENT');
                const parts = body.amount.split('.');
                const units = Number(parts[0]) * 10 ** precision + Number((parts[1] ?? '').padEnd(precision, '0'));
                send(200, store.payment(session.account, body.currency, units)); return;
            }
            if (request.method === 'POST' && request.url === '/api/renewal' && billingEnabled) { if (Object.keys(body).join(',') !== 'currency') throw new Error('INVALID_PAYMENT'); send(200, store.requestRenewal(session.account, body.currency, plans[body.currency])); return; }
            if (request.method === 'POST' && request.url === '/api/support') { if (Object.keys(body).join(',') !== 'question') throw new Error('INVALID_MESSAGE'); send(200, await support(session.account, body.question)); return; }
            if (request.method === 'POST' && request.url === '/api/allow-media' && analyzeMedia) { send(200, store.allowMedia(session.account)); return; }
            if (request.method === 'POST' && request.url === '/api/erase-history') { store.eraseHistory(session.account); send(200, { ok: true }); return; }
            send(404, { code: 'NOT_FOUND' });
        } catch (error) {
            const code = ['LOGIN_FAILED', 'SESSION_EXPIRED', 'INVALID_PAYMENT', 'PAYMENT_PENDING', 'RENEWAL_PENDING', 'RENEWAL_PLAN_UNAVAILABLE', 'INSUFFICIENT_BALANCE', 'SUPPORT_RATE_LIMIT', 'INVALID_MESSAGE', 'PANEL_UNAVAILABLE', 'MEDIA_REJECTED', 'MEDIA_CONTEXT_REQUIRED', 'MEDIA_RATE_LIMIT', 'MEDIA_UNAVAILABLE'].includes(error?.message) ? error.message : 'REQUEST_REJECTED';
            send(['LOGIN_FAILED', 'SESSION_EXPIRED'].includes(code) ? 401 : 400, { code });
        }
    });
    server.headersTimeout = 5000; server.requestTimeout = 10000; server.timeout = 55000; server.maxConnections = 32;
    server.on('clientError', (_error, socket) => socket.destroy());
    return server;
}
