import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAdministrationMcp } from './admin-mcp.mjs';
import { createBusinessAdmin } from './business-client.mjs';

test('administrative MCP exposes minimal summaries and proposals, never a confirm/write/link tool', async () => {
    let proposals = 0;
    const server = createAdministrationMcp({ card: async actor => { assert.equal(actor, 123456789); return { id: 42, status: 'ACTIVE', username: 'private', email: 'private@example.invalid', description: 'private', subscriptionUrl: 'https://example.invalid/secret', observedAt: '2026-10-16T12:00:00Z' }; }, prepare: async () => { proposals++; return { id: 'SyntheticTicket1', expiresInSeconds: 180 }; } }, 123456789);
    const client = new Client({ name: 'synthetic-test', version: '1' }); const pair = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(pair[0]), client.connect(pair[1])]);
    try {
        const tools = await client.listTools(); assert.equal(tools.tools.length, 2); assert.ok(tools.tools.every(tool => !/confirm|execute/.test(tool.name)));
        const card = await client.callTool({ name: 'get_user_summary', arguments: { reference: '42' } });
        assert.ok(!JSON.stringify(card).includes('private')); assert.ok(!JSON.stringify(card).includes('secret'));
        const proposal = await client.callTool({ name: 'prepare_user_change', arguments: { reference: '42', changes: { status: 'DISABLED' } } });
        assert.equal(JSON.parse(proposal.content[0].text).panelChanged, false); assert.equal(proposals, 1);
        assert.equal((await client.callTool({ name: 'confirm', arguments: { reference: '42' } })).isError, true);
    } finally { await client.close(); await server.close(); }
});

test('manual payment needs sole-admin preview and one-time explicit confirmation', async () => {
    const actorId = 123456789; let approved = 0;
    const handler = createBusinessAdmin({ actorId, call: async (path, value) => {
        if (path === '/pending') return { payments: [{ id: 'a'.repeat(24), currency: 'RUB', units: 10000 }], renewals: [] };
        assert.equal(path, '/approve'); assert.equal(value.id, 'a'.repeat(24)); approved++; return { credited: true };
    } });
    assert.equal(await handler({ text: 'оплаты', allowedUserId: actorId + 1 }), null);
    const preview = await handler({ text: 'платеж ' + 'a'.repeat(24) + ' test:receipt1', allowedUserId: actorId });
    assert.equal(approved, 0);
    const data = preview.reply_markup.inline_keyboard[0][0].callback_data;
    await handler({ data, allowedUserId: actorId }); await handler({ data, allowedUserId: actorId });
    assert.equal(approved, 1);
});
