import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostTest = process.platform === 'linux' && process.getuid?.() === 0;
const directory = dirname(fileURLToPath(import.meta.url));
const revision = '1'.repeat(40);
const nextRevision = '2'.repeat(40);
const botImage = 'sha256:' + 'a'.repeat(64);
const aiImage = 'sha256:' + 'b'.repeat(64);
const base = 'REMNAWAVE_BASE_URL=https://panel.example.invalid\nBOT_USERNAME=example_admin_bot\nTELEGRAM_ADMIN_ID=123456789\nPANEL_USERS_READ_ENABLED=true\n';

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'panel-ops-test-'));
    const app = join(root, 'apps', 'telegram-admin');
    const bin = join(root, 'mock-bin');
    mkdirSync(app, { recursive: true }); mkdirSync(bin);
    for (const filename of ['botctl', 'ops-host.sh']) { copyFileSync(join(directory, filename), join(app, filename)); chownSync(join(app, filename), 0, 0); chmodSync(join(app, filename), 0o755); }
    writeFileSync(join(app, '.env'), base, { mode: 0o600 });
    const log = join(root, 'commands.jsonl');
    const docker = `#!/usr/bin/env node
import fs from 'node:fs';
import { validateBaseConfiguration, validateControlConfiguration } from ${JSON.stringify(new URL('./ops-config.mjs', import.meta.url).href)};
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify(args)+'\\n');
if(args[0]!=='--host'||args[1]!=='unix:///var/run/docker.sock')process.exit(90);
args.splice(0,2);
const command=args[0];
if(command==='ps'){console.log(args.includes('-aq')?'aaaaaaaaaaaa\\nbbbbbbbbbbbb':'Synthetic project healthy');}
else if(command==='inspect'){
 const identifier=args.at(-1);const ai=identifier==='bbbbbbbbbbbb';
 const template=args[2];
 if(template==='{{.Image}}')console.log(ai?${JSON.stringify(aiImage)}:${JSON.stringify(botImage)});
 else if(template.includes('State.Status'))console.log('running|healthy');
 else console.log((ai?'ai':'bot')+'|'+(process.env.MOCK_FOREIGN?'another-directory':process.env.MOCK_APP));
}else if(command==='exec')console.log(process.env.MOCK_SETTINGS||'AI_ENABLED=true\\nBOT_ENHANCED_UI=true\\nAI_DAILY_LIMIT=100\\nPANEL_ALLOWED_REPORTS=all');
else if(command==='run'){
 if(process.env.MOCK_VALIDATION_FAIL)process.exit(2);
 const mount=args[args.indexOf('--mount')+1];const filename=mount.match(/src=([^,]+)/)[1];
 try{const text=fs.readFileSync(filename,'utf8');if(args.at(-2)==='base')validateBaseConfiguration(text);else validateControlConfiguration(text);console.log('Synthetic offline configuration valid');}catch{console.error('Synthetic configuration rejected');process.exit(2);}
}else if(command==='compose'){if(args.includes('build')&&process.env.MOCK_BUILD_FAIL)process.exit(2);}
else if(command==='image'){if(process.env.MOCK_IMAGE_GONE)process.exit(2);}
else if(!['tag','stop','logs'].includes(command))process.exit(91);
`;
    const git = `#!/usr/bin/env node
import fs from 'node:fs';
const args=process.argv.slice(2);fs.appendFileSync(process.env.MOCK_LOG,JSON.stringify(['git',...args])+'\\n');
args.splice(0,2);
const command=args[0];
if(command==='rev-parse')console.log(args[1]==='--show-toplevel'?process.env.MOCK_REPO:(fs.existsSync(process.env.MOCK_HEAD)?fs.readFileSync(process.env.MOCK_HEAD,'utf8').trim():${JSON.stringify(revision)}));
else if(command==='diff'&&process.env.MOCK_DIRTY)process.exit(2);
else if(command==='ls-files'&&process.env.MOCK_DIRTY)console.log('synthetic-dirty-file');
else if(command==='cat-file'&&process.env.MOCK_UNSUPPORTED)process.exit(2);
else if(command==='checkout'){
 fs.writeFileSync(process.env.MOCK_HEAD,args.at(-1));
 if(process.env.MOCK_REWRITE)fs.writeFileSync(process.env.MOCK_APP+'/ops-host.sh','exit 77\\n');
}
`;
    for (const [name, content] of Object.entries({ docker, git, nano: '#!/usr/bin/env node\nimport fs from "node:fs";fs.writeFileSync(process.argv.at(-1),process.env.MOCK_EDIT_TEXT);\n' })) {
        writeFileSync(join(bin, name), content, { mode: 0o755 });
    }
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_APP: app, MOCK_REPO: root, MOCK_LOG: log, MOCK_HEAD: join(root, 'mock-head') };
    const run = (args, patch = {}) => spawnSync('bash', [join(app, 'botctl'), ...args], { env: { ...env, ...patch }, encoding: 'utf8', timeout: 10000 });
    const commands = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    return { root, app, env, run, commands, log };
}

function terminal(fixture, args, { edit, tokens, ...patch } = {}) {
    return new Promise((resolve, reject) => {
        const command = ['bash', join(fixture.app, 'botctl'), ...args].map(value => "'" + value.replace(/'/g, "'\\''") + "'").join(' ');
        const child = spawn('script', ['-q', '-e', '-E', 'never', '-c', command, '/dev/null'], { env: { ...fixture.env, ...patch, ...(edit === undefined ? {} : { MOCK_EDIT_TEXT: edit }) }, stdio: ['pipe', 'pipe', 'pipe'] });
        const output = [];
        let first = false; let second = false;
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('SYNTHETIC_TERMINAL_TIMEOUT')); }, 8000);
        child.stdout.on('data', chunk => {
            output.push(chunk);
            const text = Buffer.concat(output).toString('utf8');
            if (tokens && !first && text.includes('Новый токен')) { first = true; child.stdin.write(tokens[0] + '\n'); }
            if (tokens && !second && text.includes('Повторите новый токен')) { second = true; child.stdin.write(tokens[1] + '\n'); }
        });
        child.stderr.on('data', chunk => output.push(chunk));
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => { clearTimeout(timer); resolve({ code, output: Buffer.concat(output).toString('utf8') }); });
    });
}

test('host helper help/status/adopt do not restart services and reject foreign project ownership', { skip: !hostTest }, () => {
    const fixtureState = fixture();
    assert.equal(fixtureState.run(['help']).status, 0);
    assert.equal(fixtureState.commands().length, 0);
    assert.equal(fixtureState.run(['status']).status, 0);
    assert.equal(fixtureState.run(['adopt']).status, 0);
    assert.match(readFileSync(join(fixtureState.app, '.ops/settings.env'), 'utf8'), /AI_DAILY_LIMIT=100/);
    assert.ok(!fixtureState.commands().some(args => args.includes('up') || args.includes('stop')));
    assert.notEqual(fixtureState.run(['stop'], { MOCK_FOREIGN: 'true' }).status, 0);
    assert.ok(!fixtureState.commands().some(args => args.includes('stop')));
    const invalid = fixture();
    assert.notEqual(invalid.run(['adopt'], { MOCK_SETTINGS: 'AI_ENABLED=true\nBOT_ENHANCED_UI=true\nAI_DAILY_LIMIT=101\nPANEL_ALLOWED_REPORTS=all' }).status, 0);
    assert.ok(!existsSync(join(invalid.app, '.ops/settings.env')));
});

test('host apply validates offline, keeps controls consistent and touches no volumes or unrelated services', { skip: !hostTest }, () => {
    const fixtureState = fixture();
    assert.equal(fixtureState.run(['adopt']).status, 0);
    assert.equal(fixtureState.run(['apply']).status, 0);
    const commands = fixtureState.commands();
    const applied = commands.find(args => args.includes('up'));
    assert.ok(applied.includes('--no-deps') && applied.includes('--force-recreate'));
    assert.deepEqual(applied.slice(-2), ['ai', 'bot']);
    for (const args of commands.filter(args => args.includes('run'))) assert.ok(args.includes('--network') && args.includes('none') && !args.some(value => value.includes('src=/var/run/docker.sock')));
    assert.ok(!commands.some(args => args.some(value => ['down', 'prune', 'volume', 'rm', 'system'].includes(value))));
    assert.match(readFileSync(join(fixtureState.app, '.ops/active.env'), 'utf8'), /REVISION=111111/);
    assert.equal(readFileSync(join(fixtureState.app, '.env'), 'utf8'), base);
});

test('failed validation cannot fall through to apply and dirty source is never reset', { skip: !hostTest }, () => {
    const fixtureState = fixture(); assert.equal(fixtureState.run(['adopt']).status, 0);
    assert.notEqual(fixtureState.run(['apply'], { MOCK_VALIDATION_FAIL: 'true' }).status, 0);
    assert.notEqual(fixtureState.run(['apply'], { MOCK_DIRTY: 'true' }).status, 0);
    assert.ok(!fixtureState.commands().some(args => args.includes('up') || args.includes('checkout')));
    assert.equal(readFileSync(join(fixtureState.app, '.env'), 'utf8'), base);
});

test('nano edits are validated before atomic replacement and malformed settings remain repairable', { skip: !hostTest }, async () => {
    const fixtureState = fixture(); fixtureState.run(['adopt']);
    const invalid = await terminal(fixtureState, ['config'], { edit: base.replace('example_admin_bot', '$(touch marker)') });
    assert.notEqual(invalid.code, 0);
    assert.equal(readFileSync(join(fixtureState.app, '.env'), 'utf8'), base);
    assert.ok(!existsSync(join(fixtureState.root, 'marker')));
    writeFileSync(join(fixtureState.app, '.ops/settings.env'), 'broken', { mode: 0o600 });
    const text = 'AI_ENABLED=true\nBOT_ENHANCED_UI=true\nAI_DAILY_LIMIT=10\nPANEL_ALLOWED_REPORTS=stats,nodes\n';
    const valid = await terminal(fixtureState, ['settings'], { edit: text });
    assert.equal(valid.code, 0, valid.output);
    assert.equal(readFileSync(join(fixtureState.app, '.ops/settings.env'), 'utf8'), text);
    assert.ok(!fixtureState.commands().some(args => args.includes('up')));
});

test('token replacement uses hidden matching input, never prints values and does not restart containers', { skip: !hostTest }, async () => {
    const fixtureState = fixture();
    mkdirSync(join(fixtureState.app, 'secrets'), { mode: 0o700 });
    const filename = join(fixtureState.app, 'secrets/panel-api-token.txt');
    writeFileSync(filename, 'SYNTHETIC_OLD_VALUE', { mode: 0o400 });
    const fake = 'SYNTHETIC_NEW_VALUE';
    const mismatch = await terminal(fixtureState, ['token', 'panel'], { tokens: [fake, 'DIFFERENT_SYNTHETIC_VALUE'] });
    assert.notEqual(mismatch.code, 0);
    assert.equal(readFileSync(filename, 'utf8'), 'SYNTHETIC_OLD_VALUE');
    const valid = await terminal(fixtureState, ['token', 'panel'], { tokens: [fake, fake] });
    assert.equal(valid.code, 0, valid.output);
    assert.equal(readFileSync(filename, 'utf8'), fake + '\n');
    assert.ok(!valid.output.includes(fake) && !mismatch.output.includes(fake));
    assert.ok(!fixtureState.commands().some(args => args.includes('up') || args.includes('run')));
});

test('update is preparation only, failure restores tags/source, and rollback does not rewind data', { skip: !hostTest }, () => {
    const fixtureState = fixture(); fixtureState.run(['adopt']); assert.equal(fixtureState.run(['apply']).status, 0);
    writeFileSync(fixtureState.log, '');
    const failed = fixtureState.run(['update', nextRevision], { MOCK_BUILD_FAIL: 'true' });
    assert.notEqual(failed.status, 0);
    assert.equal(readFileSync(fixtureState.env.MOCK_HEAD, 'utf8'), revision);
    assert.ok(!existsSync(join(fixtureState.app, '.ops/pending')));
    writeFileSync(fixtureState.log, '');
    assert.equal(fixtureState.run(['update', nextRevision]).status, 0);
    assert.equal(readFileSync(fixtureState.env.MOCK_HEAD, 'utf8'), nextRevision);
    assert.ok(!fixtureState.commands().some(args => args.includes('up') || args.includes('stop')));
    assert.notEqual(fixtureState.run(['update', nextRevision]).status, 0);
    assert.equal(fixtureState.run(['rollback']).status, 0);
    assert.equal(readFileSync(fixtureState.env.MOCK_HEAD, 'utf8'), revision);
    assert.ok(!fixtureState.commands().some(args => args.includes('up') || args.includes('volume')));
});

test('self-updating helper runs its immutable loaded implementation and does not execute new shell tails', { skip: !hostTest }, () => {
    const fixtureState = fixture(); fixtureState.run(['adopt']); assert.equal(fixtureState.run(['apply']).status, 0);
    assert.equal(fixtureState.run(['update', nextRevision], { MOCK_REWRITE: 'true' }).status, 0);
    assert.equal(readFileSync(join(fixtureState.app, 'ops-host.sh'), 'utf8'), 'exit 77\n');
});
