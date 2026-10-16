import { mkdirSync, chmodSync, existsSync, unlinkSync, readFileSync, statSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createBusinessStore, createSupport } from './store.mjs';
import { createPortal } from './portal.mjs';
import { createUserClient } from '../telegram-admin/admin-users.mjs';
import { createReferenceSearch } from './reference-search.mjs';
import { createMediaAnalyzer } from './media-client.mjs';
import { validateBusinessEnv } from './config.mjs';
import { createGuideLibrary } from './guides.mjs';

let store; let portal; let administration;
try {
process.umask(0o077);
validateBusinessEnv(process.env);
const enabled = name => { if (!['true', 'false'].includes(process.env[name] ?? 'false')) throw new Error('INVALID_BUSINESS_CONFIGURATION'); return process.env[name] === 'true'; };
if (!enabled('PORTAL_ENABLED')) throw new Error('PORTAL_NOT_AUTHORIZED');
mkdirSync('/state', { recursive: true, mode: 0o700 });
mkdirSync('/business-bridge', { recursive: true, mode: 0o700 });
store = createBusinessStore({ filename: '/state/business.sqlite' });
for (const item of JSON.parse(readFileSync(new URL('./faq.json', import.meta.url), 'utf8'))) store.addKnowledge(item.id, item.aliases, item.answer);
const supportAi = enabled('SUPPORT_AI_ENABLED');
const support = createSupport({ store, search: enabled('SEARCH_ENABLED') ? createReferenceSearch({ store, allowedHosts: (process.env.SEARCH_ALLOWED_HOSTS ?? 'docs.rw').split(','), dailyLimit: Number(process.env.SEARCH_DAILY_LIMIT ?? 0) }) : undefined, answer: supportAi ? value => new Promise((resolve, reject) => {
    const call = request({ socketPath: '/bridge/classifier.sock', method: 'POST', path: '/support', headers: { 'Content-Type': 'application/json' }, timeout: 50000 }, response => {
        let text = ''; response.on('data', chunk => { text += chunk; if (text.length > 4096) response.destroy(); }); response.on('error', () => reject(new Error('SUPPORT_UNAVAILABLE')));
        response.on('end', () => { try { if (response.statusCode !== 200) throw new Error(); resolve(JSON.parse(text)); } catch { reject(new Error('SUPPORT_UNAVAILABLE')); } });
    }); call.on('error', () => reject(new Error('SUPPORT_UNAVAILABLE'))); call.on('timeout', () => call.destroy()); call.end(JSON.stringify(value));
}) : undefined });
const client = enabled('PORTAL_PANEL_READ_ENABLED') ? createUserClient({ baseUrl: process.env.REMNAWAVE_BASE_URL, readTokenFile: '/run/secrets/panel_api_token' }) : undefined;
const manualBilling = enabled('BILLING_MANUAL_ENABLED');
portal = createPortal({ store, support, origin: process.env.PORTAL_PUBLIC_ORIGIN, billingEnabled: manualBilling, guides: createGuideLibrary(), analyzeMedia: enabled('MEDIA_ENABLED') ? createMediaAnalyzer({ applications: process.env.MEDIA_ALLOWED_APPS ?? 'happ' }) : undefined, maxMediaBytes: Number(process.env.MEDIA_MAX_BYTES ?? 5242880), plans: { RUB: { units: Number(process.env.PLAN_RUB_UNITS ?? 0), days: Number(process.env.PLAN_DAYS ?? 30) }, USDT: { units: Number(process.env.PLAN_USDT_UNITS ?? 0), days: Number(process.env.PLAN_DAYS ?? 30) } }, panelRead: client ? async id => {
    const user = await client.get(String(id));
    if (user?.id !== id || !['ACTIVE', 'DISABLED', 'EXPIRED', 'LIMITED'].includes(user.status) || typeof user.expireAt !== 'string') throw new Error('PANEL_UNAVAILABLE');
    return { status: user.status, expireAt: user.expireAt, observedAt: new Date().toISOString() };
} : undefined });
const socket = '/business-bridge/admin.sock';
if (existsSync(socket)) { if (!statSync(socket).isSocket()) throw new Error('INVALID_BUSINESS_SOCKET'); unlinkSync(socket); }
administration = createServer(async (incoming, outgoing) => {
    const send = (status, value) => outgoing.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    try {
        if (incoming.method === 'GET' && incoming.url === '/pending') { send(200, { payments: store.pendingPayments(), renewals: store.pendingRenewals(), support: store.pendingSupport() }); return; }
        if (incoming.method === 'GET' && /^\/support\/[a-f0-9]{24}$/.test(incoming.url)) { send(200, store.supportThread(incoming.url.split('/').at(-1))); return; }
        if (incoming.method === 'GET' && /^\/media\/[a-f0-9]{24}$/.test(incoming.url)) { send(200, store.mediaReview(incoming.url.split('/').at(-1))); return; }
        if (incoming.method !== 'POST' || !['/approve', '/reject', '/support-reply', '/renewal-reserve', '/renewal-settle', '/media-approve'].includes(incoming.url) || incoming.headers['content-type'] !== 'application/json') throw new Error();
        if (['/approve', '/reject', '/renewal-reserve', '/renewal-settle'].includes(incoming.url) && !manualBilling) throw new Error();
        let body = ''; for await (const chunk of incoming) { body += chunk; if (body.length > 4096) throw new Error(); }
        const value = JSON.parse(body);
        if (incoming.url === '/media-approve') {
            if (!value || Object.keys(value).join(',') !== 'id' || !/^[a-f0-9]{24}$/.test(value.id)) throw new Error();
            const review = store.approveMedia(value.id);
            try { send(200, await support(review.account, 'Помоги с проверенным администратором текстом вложения.')); }
            catch { send(200, { reply: 'Проверенный текст сохранён; новый вызов ИИ сейчас недоступен. Автоматического повтора нет.' }); }
            return;
        }
        if (incoming.url === '/renewal-reserve') {
            if (!value || Object.keys(value).sort().join(',') !== 'id,proposal' || !/^[a-f0-9]{24}$/.test(value.id)) throw new Error();
            send(200, store.reserveRenewal(value.id, value.proposal)); return;
        }
        if (incoming.url === '/renewal-settle') {
            if (!value || Object.keys(value).sort().join(',') !== 'id,outcome' || !/^[a-f0-9]{24}$/.test(value.id)) throw new Error();
            send(200, store.settleRenewal(value.id, value.outcome)); return;
        }
        if (incoming.url === '/support-reply') {
            if (!value || Object.keys(value).sort().join(',') !== 'id,text' || !/^[a-f0-9]{24}$/.test(value.id)) throw new Error();
            send(200, store.replySupport(value.id, value.text)); return;
        }
        if (!value || !/^[a-f0-9]{24}$/.test(value.id) || (incoming.url === '/approve' ? Object.keys(value).sort().join(',') !== 'id,reference' : Object.keys(value).join(',') !== 'id')) throw new Error();
        if (incoming.url === '/approve') send(200, store.approvePayment(value.id, value.reference));
        else { store.rejectPayment(value.id); send(200, { rejected: true }); }
    } catch { send(400, { code: 'BUSINESS_REQUEST_REJECTED' }); }
});
administration.headersTimeout = 5000; administration.requestTimeout = 5000; administration.timeout = 55000; administration.maxConnections = 4;
administration.on('clientError', (_error, connection) => connection.destroy());
await new Promise(resolve => administration.listen(socket, resolve)); chmodSync(socket, 0o600);
await new Promise(resolve => portal.listen(8787, '0.0.0.0', resolve));
process.stdout.write(JSON.stringify({ ready: true, customerSending: false, manualBilling }) + '\n');
const stop = () => { portal.closeAllConnections(); administration.closeAllConnections(); portal.close(); administration.close(() => { store.close(); process.exitCode = 0; }); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
} catch {
    portal?.closeAllConnections(); administration?.closeAllConnections(); portal?.close(); administration?.close(); store?.close();
    process.stderr.write('Business modules unavailable. Verify explicit enablement and validated private configuration; no private values printed.\n');
    process.exitCode = 2;
}
