import test from 'node:test';
import assert from 'node:assert/strict';
import { createBusinessStore, createSupport } from './store.mjs';
import { createReferenceSearch } from './reference-search.mjs';
import { createClassifierServer } from '../telegram-admin/ai-worker.mjs';
import { createIntentStore } from '../telegram-admin/intent-store.mjs';
import { request } from 'node:http';

test('web search is closed to arbitrary queries, filters hosts, and shares only public cached references', async () => {
    const store = createBusinessStore({ filename: ':memory:' }); let calls = 0;
    try {
        const search = createReferenceSearch({ store, dailyLimit: 1, readToken: () => 'synthetic-key', fetchImpl: async (url, options) => {
            calls++; assert.equal(url.origin, 'https://api.search.brave.com'); assert.equal(options.redirect, 'error');
            return new Response(JSON.stringify({ web: { results: [{ title: 'Untrusted', url: 'https://attacker.invalid/x', description: 'must be ignored' }, { title: 'Guide', url: 'https://docs.rw/guide', description: 'Public connection instructions.' }] } }));
        } });
        await assert.rejects(search('найди пароль клиента'), /QUERY_REJECTED/); assert.equal(calls, 0);
        assert.equal((await search('найди инструкцию для happ'))[0].url, 'https://docs.rw/guide');
        await search('найди инструкцию для happ'); assert.equal(calls, 1);
        await assert.rejects(search('найди инструкцию для hiddify'), /SEARCH_LIMIT/); assert.equal(calls, 1);
        const disabled = createReferenceSearch({ store, dailyLimit: 0, readToken: () => { throw new Error('MUST_NOT_READ'); } });
        await assert.rejects(disabled('найди инструкцию для v2rayn'), /SEARCH_DISABLED/);
    } finally { store.close(); }
});

test('media requires an active isolated case, one-time consent, and admin approval before any AI history', async () => {
    let time = 1000000; const store = createBusinessStore({ filename: ':memory:', now: () => time });
    const first = store.provision('first@example.invalid', 'synthetic-password-only', 1).id;
    const second = store.provision('second@example.invalid', 'synthetic-password-only', 2).id;
    try {
        assert.throws(() => store.allowMedia(first), /CONTEXT/);
        store.append(first, 'user', 'Не работает подключение'); store.handoff(first); store.allowMedia(first);
        assert.throws(() => store.consumeMedia(second), /CONTEXT/);
        store.consumeMedia(first); assert.throws(() => store.consumeMedia(first), /CONTEXT/);
        const media = store.queueMedia(first, 'Happ synthetic unique OCR');
        assert.ok(!JSON.stringify(store.history(first)).includes('unique OCR')); assert.ok(!JSON.stringify(store.history(second)).includes('unique OCR'));
        store.approveMedia(media.id); assert.ok(JSON.stringify(store.history(first)).includes('unique OCR'));
        assert.throws(() => store.approveMedia(media.id));
        time += 60001; store.allowMedia(first); time += 300001; assert.throws(() => store.consumeMedia(first));
    } finally { store.close(); }
});

test('support and admin classification share the same worker quota, and usage reads spend nothing', async () => {
    const store = createIntentStore({ filename: ':memory:', dailyLimit: 1 }); let adminCalls = 0; let supportCalls = 0;
    const server = createClassifierServer({ store, classify: async () => { adminCalls++; return { action: 'stats', days: 3 }; }, support: async () => { supportCalls++; return { reply: 'Уточните приложение.', needsHuman: true }; } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (path, value) => new Promise((resolve, reject) => {
        const outgoing = request(base + path, { agent: false, method: value === undefined ? 'GET' : 'POST', headers: value === undefined ? {} : { 'Content-Type': 'application/json' } }, incoming => {
            let body = ''; incoming.on('data', chunk => { body += chunk; }); incoming.on('end', () => resolve(new Response(body, { status: incoming.statusCode })));
        }); outgoing.on('error', reject); outgoing.end(value === undefined ? undefined : JSON.stringify(value));
    });
    try {
        assert.equal((await (await call('/usage')).json()).used, 0);
        const response = await call('/support', { question: 'Помоги подключиться', knowledge: [], history: [] });
        assert.equal(response.status, 200); assert.equal(supportCalls, 1);
        const blocked = await call('/classify', { question: 'Проверь общую статистику' });
        assert.equal(blocked.status, 429); assert.equal(adminCalls, 0);
        assert.equal((await (await call('/usage')).json()).used, 1);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); }
});
