import test from 'node:test';
import assert from 'node:assert/strict';
import { RemnawaveClient, ApiError } from '../dist/client.js';

function client(overrides = {}) {
    return new RemnawaveClient({ baseUrl: 'https://panel.example.invalid', headers: {}, timeoutMs: 1000, ...overrides });
}

async function withFetch(implementation, action) {
    const original = globalThis.fetch;
    globalThis.fetch = implementation;
    try { await action(); } finally { globalThis.fetch = original; }
}

test('upstream errors never include response credentials or customer data', async () => {
    await withFetch(async () => new Response(JSON.stringify({ message: 'password=DEMO_SECRET telegramId=123456789' }), { status: 403 }), async () => {
        await assert.rejects(client().request('GET', '/api/users/'), error => {
            assert.ok(error instanceof ApiError);
            assert.equal(error.status, 403);
            assert.ok(!error.message.includes('DEMO_SECRET'));
            assert.ok(!error.message.includes('123456789'));
            return true;
        });
    });
});

test('authenticated requests refuse redirects', async () => {
    await withFetch(async (url, options) => {
        assert.equal(options.redirect, 'error');
        return new Response('{"response":{"ok":true}}');
    }, async () => assert.deepEqual(await client().request('GET', '/api/system/metadata'), { ok: true }));
});

test('raw response limit applies before parsing or redaction', async () => {
    await withFetch(async () => new Response('x'.repeat(100)), async () => {
        await assert.rejects(client({ maxResponseBytes: 32 }).request('GET', '/api/users/'), /response exceeds/i);
    });
});

test('declared oversized responses are rejected', async () => {
    await withFetch(async () => new Response('{}', { headers: { 'content-length': '9999' } }), async () => {
        await assert.rejects(client({ maxResponseBytes: 32 }).request('GET', '/api/users/'), /response exceeds/i);
    });
});
