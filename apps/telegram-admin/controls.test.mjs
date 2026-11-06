import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { readRuntimeControls, applyReportPolicy } from './runtime-controls.mjs';
import { parsePrivateEnv, validateBaseConfiguration, validateControlConfiguration, baseKeys } from './ops-config.mjs';
import { createConfiguredService } from './configured-service.mjs';
import { createPanelService } from './panel-service.mjs';
import { connectReportMcp } from './report-mcp.mjs';
import { createDashboard } from './dashboard.mjs';
import { createIntentStore } from './intent-store.mjs';
import { reportActions } from './intent.mjs';

const base = 'REMNAWAVE_BASE_URL=https://panel.example.invalid\nBOT_USERNAME=example_admin_bot\nTELEGRAM_ADMIN_ID=123456789\nPANEL_USERS_READ_ENABLED=true\n';
const controls = 'AI_ENABLED=true\nBOT_ENHANCED_UI=true\nAI_DAILY_LIMIT=100\nPANEL_ALLOWED_REPORTS=all\n';

test('runtime controls default to the accepted behaviour and permit only finite caps zero through one hundred', () => {
    assert.deepEqual(readRuntimeControls({}), { dailyLimit: 100, allowedReports: reportActions });
    for (const value of ['0', '1', '10', '100']) assert.equal(readRuntimeControls({ AI_DAILY_LIMIT: value }).dailyLimit, Number(value));
    for (const value of ['', '-1', '101', 'Infinity', '1.5', '00', ' 10', 10, null]) assert.throws(() => readRuntimeControls({ AI_DAILY_LIMIT: value }), /INVALID_RUNTIME_CONTROLS/);
});

test('report policy is a local fixed allowlist, never a URL, arbitrary method or token-scope editor', () => {
    assert.deepEqual(readRuntimeControls({ PANEL_ALLOWED_REPORTS: 'none' }).allowedReports, []);
    assert.deepEqual(readRuntimeControls({ PANEL_ALLOWED_REPORTS: 'stats,nodes' }).allowedReports, ['stats', 'nodes']);
    for (const value of ['', 'stats,stats', 'stats,', ' stats', 'delete_user', '*', 'https://example.invalid']) assert.throws(() => readRuntimeControls({ PANEL_ALLOWED_REPORTS: value }));
});

test('denied reports refuse before credential access, client creation or a real MCP service call', async () => {
    const configured = createConfiguredService({ baseUrl: 'https://panel.example.invalid', tokenFile: '/not-mounted', allowedReports: [] });
    await assert.rejects(configured.stats(), /REPORT_DISABLED/);
    let factories = 0;
    const service = applyReportPolicy(createPanelService({ clientFactory: () => { factories++; throw new Error('MUST_NOT_OPEN'); } }), []);
    const mcp = await connectReportMcp(service);
    try {
        for (const action of reportActions) {
            await assert.rejects(service[action](), /REPORT_DISABLED/);
            await assert.rejects(mcp.read(action), /REPORT_DISABLED/);
        }
        assert.equal(factories, 0);
    } finally { await mcp.close(); }
});

test('allowed direct and MCP reports remain fresh while the dashboard explains a disabled section', async () => {
    let reads = 0;
    const service = applyReportPolicy({ stats: async () => ({ totalUsers: 10, usersOnline: ++reads, observedAt: '2026-10-16T09:00:00.000Z' }) }, ['stats']);
    const mcp = await connectReportMcp(service);
    try {
        assert.equal((await service.stats()).usersOnline, 1);
        assert.equal((await mcp.read('stats')).usersOnline, 2);
        const handle = createDashboard({ allowedUserId: 123456789, service, now: () => Date.UTC(2026, 9, 16, 9), enhancedUi: true });
        const reply = await handle({ update_id: 1, message: { text: '/nodes', date: Date.UTC(2026, 9, 16, 9) / 1000, chat: { id: 123456789, type: 'private' }, from: { id: 123456789, is_bot: false } } });
        assert.match(reply.text, /отключён в локальных разрешениях/);
        assert.equal(reads, 2);
    } finally { await mcp.close(); }
});

test('lowering the configured budget never refunds prior uses or permits a reserve at zero', () => {
    let clock = Date.UTC(2026, 9, 16, 9);
    const store = createIntentStore({ filename: ':memory:', ...{ dailyLimit: readRuntimeControls({ AI_DAILY_LIMIT: '2' }).dailyLimit }, now: () => clock });
    try {
        store.reserve(); clock += 60000; store.reserve(); clock += 60000;
        assert.equal(store.status().used, 2);
        assert.throws(() => store.reserve(), /AI_DAILY_LIMIT/);
    } finally { store.close(); }
    const disabled = createIntentStore({ filename: ':memory:', dailyLimit: readRuntimeControls({ AI_DAILY_LIMIT: '0' }).dailyLimit });
    try { assert.throws(() => disabled.reserve(), /AI_DAILY_LIMIT/); }
    finally { disabled.close(); }
});

test('private configuration parser accepts only known literal values and never executes shell interpolation', () => {
    assert.equal(validateBaseConfiguration(base), true);
    assert.equal(validateControlConfiguration(controls).dailyLimit, 100);
    assert.equal(validateControlConfiguration(controls.replace('=100', '=0')).dailyLimit, 0);
    assert.equal(parsePrivateEnv('# comment\n' + base.replace(/\n/g, '\r\n'), baseKeys).BOT_USERNAME, 'example_admin_bot');
    for (const invalid of [base + 'UNKNOWN=value\n', base + 'BOT_USERNAME=duplicate\n', base.replace('example_admin_bot', '$(touch marker)'), base.replace('example_admin_bot', '`id`'), base.replace('https://panel.example.invalid', 'http://panel.example.invalid'), base.replace('https://panel.example.invalid', 'https://user:pass@panel.example.invalid'), base.replace('https://panel.example.invalid', 'https://panel.example.invalid/api'), base + 'x'.repeat(4096)]) assert.throws(() => validateBaseConfiguration(invalid));
    for (const invalid of [controls.replace('=100', '=101'), controls.replace('AI_ENABLED=true', 'AI_ENABLED=yes'), controls.replace('PANEL_ALLOWED_REPORTS=all', 'PANEL_ALLOWED_REPORTS=delete_user'), controls.replace('AI_DAILY_LIMIT=100\n', '')]) assert.throws(() => validateControlConfiguration(invalid));
});

test('both runtime entrypoints receive the configured cap and host controls never mount a Docker socket into services', () => {
    for (const filename of ['start-server.mjs', 'start-ai.mjs']) assert.match(readFileSync(new URL(filename, import.meta.url), 'utf8'), /dailyLimit: (?:config|controls)\.dailyLimit/);
    for (const filename of ['compose.yaml', 'compose.ai.yaml', 'compose.controls.yaml', 'compose.controls.ai.yaml']) assert.ok(!readFileSync(new URL(filename, import.meta.url), 'utf8').includes('/var/run/docker.sock'));
    const host = readFileSync(new URL('ops-host.sh', import.meta.url), 'utf8');
    for (const action of reportActions) assert.ok(host.includes(action));
    assert.ok(!host.includes('source '));
    assert.ok(!host.includes('eval '));
    assert.ok(!host.includes('down -v'));
    assert.ok(!host.includes('prune'));
    assert.ok(!host.includes('acknowledge'));
    assert.match(host, /--network none/);
    assert.match(host, /--force-recreate/);
    assert.match(host, /--no-deps/);
    assert.match(readFileSync(new URL('botctl', import.meta.url), 'utf8'), /bash -c "\$implementation"/);
});
