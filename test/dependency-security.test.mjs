import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { UpdateUserCommand } from '@remnawave/backend-contract';

const require = createRequire(import.meta.url);
const packageInfo = name => JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8'));

test('security pins install patched libraries without changing the MCP SDK or panel contract', () => {
    const patched = { zod: '4.6.6', 'body-parser': '2.4.0', 'fast-uri': '3.1.9', 'ip-address': '10.7.4', qs: '6.16.1' };
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
    assert.equal(manifest.dependencies['@modelcontextprotocol/sdk'], '1.32.1');
    assert.equal(manifest.dependencies['@remnawave/backend-contract'], '3.4.5');
    assert.equal(packageInfo('@modelcontextprotocol/sdk').version, '1.32.1');
    assert.equal(packageInfo('@remnawave/backend-contract').version, '3.4.5');
    assert.equal(manifest.overrides.zod, '$zod');
    for (const [name, version] of Object.entries(patched)) {
        assert.equal(packageInfo(name).version, version);
        assert.equal(lock.packages['node_modules/' + name].version, version);
        assert.equal(name === 'zod' ? manifest.dependencies.zod : manifest.overrides[name], version);
    }
});

test('the SDK and contract resolve the same patched Zod rather than a vulnerable nested copy', () => {
    const expected = require.resolve('zod/package.json');
    for (const entry of ['@remnawave/backend-contract', '@modelcontextprotocol/sdk/server/mcp.js']) {
        const consumer = createRequire(require.resolve(entry));
        assert.equal(consumer.resolve('zod/package.json'), expected);
        assert.equal(JSON.parse(readFileSync(consumer.resolve('zod/package.json'), 'utf8')).version, '4.6.6');
    }
});

test('contract 3.4.5 retains its date transform and field validation with patched Zod', () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const input = { id: 42, status: 'ACTIVE', expireAt: future, description: 'synthetic', email: 'test@example.invalid', telegramId: 123456789, trafficLimitBytes: 1024, tag: 'MCP_TEST', hwidDeviceLimit: 2 };
    const parsed = UpdateUserCommand.RequestBodySchema.parse(input);
    assert.ok(parsed.expireAt instanceof Date);
    assert.equal(parsed.expireAt.toISOString(), future);
    const wire = JSON.parse(JSON.stringify(parsed));
    assert.deepEqual(wire, input);
    assert.equal(UpdateUserCommand.RequestBodySchema.safeParse(wire).success, true);
    for (const changes of [{ status: 'EXPIRED' }, { trafficLimitBytes: -1 }, { tag: 'lower case' }, { email: 'not-an-email' }, { hwidDeviceLimit: 1.5 }]) assert.equal(UpdateUserCommand.RequestBodySchema.safeParse({ ...input, ...changes }).success, false);
});
