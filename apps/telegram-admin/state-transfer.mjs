import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const files = { bot: ['intent-cache.sqlite', 'admin.sqlite', 'offset.json', 'receiver-safety.json'], ai: ['ai-quota.sqlite', 'receiver-safety.json', 'classifier-paused'], business: ['business.sqlite'] };
const sha = filename => createHash('sha256').update(readFileSync(filename)).digest('hex');
const regular = filename => { const value = lstatSync(filename); if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1 || value.size > 100 * 1024 * 1024) throw new Error('INVALID_SNAPSHOT_FILE'); };
function checkDatabase(filename) {
    const database = new DatabaseSync(filename, { readOnly: true });
    try { database.exec('PRAGMA trusted_schema=OFF'); if (database.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('INVALID_SNAPSHOT_DATABASE'); }
    finally { database.close(); }
}

export function exportState({ sources, destination, revision, now = Date.now }) {
    if (!/^[a-f0-9]{40}$/.test(revision) || (existsSync(destination) && readdirSync(destination).length)) throw new Error('INVALID_SNAPSHOT_DESTINATION');
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    const manifest = { version: 1, revision, createdAt: new Date(now()).toISOString(), credentialFilesIncluded: false, stoppedSourceRequired: true, files: [] };
    for (const [kind, names] of Object.entries(files)) {
        const output = join(destination, kind); mkdirSync(output, { mode: 0o700 });
        for (const name of names) {
            const source = join(sources[kind], name);
            if (!existsSync(source)) continue;
            regular(source);
            const target = join(output, name);
            if (name.endsWith('.sqlite')) {
                checkDatabase(source);
                const database = new DatabaseSync(source, { readOnly: true });
                try { database.exec('PRAGMA trusted_schema=OFF'); database.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`); }
                finally { database.close(); }
                checkDatabase(target);
            } else {
                if (lstatSync(source).size > 4096) throw new Error('INVALID_SNAPSHOT_FILE');
                copyFileSync(source, target);
            }
            manifest.files.push({ kind, name, sha256: sha(target) });
        }
    }
    writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return { files: manifest.files.length, revision };
}

export function restoreState({ snapshot, targets, revision }) {
    regular(join(snapshot, 'manifest.json'));
    if (lstatSync(join(snapshot, 'manifest.json')).size > 16384) throw new Error('INVALID_SNAPSHOT');
    const manifest = JSON.parse(readFileSync(join(snapshot, 'manifest.json'), 'utf8'));
    if (manifest.version !== 1 || manifest.revision !== revision || manifest.stoppedSourceRequired !== true || manifest.credentialFilesIncluded !== false || !Array.isArray(manifest.files) || manifest.files.length > 9) throw new Error('INVALID_SNAPSHOT');
    const seen = new Set();
    for (const [kind, names] of Object.entries(files)) {
        if (!targets[kind] || names.some(name => existsSync(join(targets[kind], name)))) throw new Error('RESTORE_REQUIRES_EMPTY_STATE');
        if (existsSync(targets[kind]) && lstatSync(targets[kind]).isSymbolicLink()) throw new Error('INVALID_RESTORE_TARGET');
        if (existsSync(targets[kind]) && readdirSync(targets[kind]).some(name => name !== 'heartbeat.json')) throw new Error('RESTORE_REQUIRES_EMPTY_STATE');
    }
    for (const item of manifest.files) {
        if (!files[item.kind]?.includes(item.name) || seen.has(`${item.kind}/${item.name}`) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('INVALID_SNAPSHOT');
        if ((process.env.STATE_MISSING_KINDS ?? '').split(',').includes(item.kind)) throw new Error('RESTORE_VOLUME_MISSING');
        seen.add(`${item.kind}/${item.name}`);
        if (lstatSync(join(snapshot, item.kind)).isSymbolicLink()) throw new Error('INVALID_SNAPSHOT');
        const source = join(snapshot, item.kind, item.name); regular(source);
        if (sha(source) !== item.sha256) throw new Error('INVALID_SNAPSHOT_HASH');
        if (item.name.endsWith('.sqlite')) checkDatabase(source);
    }
    for (const item of manifest.files) { mkdirSync(targets[item.kind], { recursive: true, mode: 0o700 }); copyFileSync(join(snapshot, item.kind, item.name), join(targets[item.kind], item.name)); }
    const customerDatabase = join(targets.business, 'business.sqlite');
    if (existsSync(customerDatabase)) { const database = new DatabaseSync(customerDatabase); try { database.exec('DELETE FROM sessions'); } finally { database.close(); } }
    const administrationDatabase = join(targets.bot, 'admin.sqlite');
    if (existsSync(administrationDatabase)) { const database = new DatabaseSync(administrationDatabase); try { database.exec("UPDATE confirmations SET state='cancelled', payload='{}' WHERE state='pending'"); } finally { database.close(); } }
    return { restored: manifest.files.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.umask(0o077);
    try {
        const [mode, revision] = process.argv.slice(2);
        if (process.argv.length !== 4 || !['export', 'restore'].includes(mode) || !/^[a-f0-9]{40}$/.test(revision)) throw new Error('INVALID_SNAPSHOT');
        const directories = { bot: '/source/bot', ai: '/source/ai', business: '/source/business' };
        const result = mode === 'export' ? exportState({ sources: directories, destination: '/snapshot', revision }) : restoreState({ snapshot: '/snapshot', targets: directories, revision });
        process.stdout.write(JSON.stringify(result) + '\n');
    } catch { process.stderr.write('State transfer rejected. No tokens or authentication are included.\n'); process.exitCode = 2; }
}
