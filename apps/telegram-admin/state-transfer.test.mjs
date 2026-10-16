import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { exportState, restoreState } from './state-transfer.mjs';
const revision = 'a'.repeat(40);
function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'panel-state-transfer-'));
    const sources = {}; const targets = {};
    for (const kind of ['bot', 'ai', 'business']) { sources[kind] = join(directory, 'old-' + kind); targets[kind] = join(directory, 'new-' + kind); mkdirSync(sources[kind]); mkdirSync(targets[kind]); }
    return { directory, sources, targets, destination: join(directory, 'snapshot'), close: () => rmSync(directory, { recursive: true, force: true }) };
}
test('consistent SQLite snapshot includes quotas/offsets/pauses but not credential files', () => {
    const state = fixture();
    try {
        const filename = join(state.sources.bot, 'intent-cache.sqlite'); const database = new DatabaseSync(filename);
        database.exec('PRAGMA journal_mode=WAL; CREATE TABLE quota (used INTEGER); INSERT INTO quota VALUES (27)');
        writeFileSync(join(state.sources.bot, 'offset.json'), '{"offset":1234}');
        writeFileSync(join(state.sources.ai, 'classifier-paused'), 'pause');
        writeFileSync(join(state.sources.bot, 'never-read.private'), 'synthetic-omitted-marker');
        exportState({ sources: state.sources, destination: state.destination, revision }); database.close();
        assert.equal(existsSync(join(state.destination, 'bot', 'never-read.private')), false);
        restoreState({ snapshot: state.destination, targets: state.targets, revision });
        const restored = new DatabaseSync(join(state.targets.bot, 'intent-cache.sqlite'));
        assert.equal(restored.prepare('SELECT used FROM quota').get().used, 27); restored.close();
        assert.equal(readFileSync(join(state.targets.bot, 'offset.json'), 'utf8'), '{"offset":1234}');
        assert.equal(readFileSync(join(state.targets.ai, 'classifier-paused'), 'utf8'), 'pause');
        assert.throws(() => restoreState({ snapshot: state.destination, targets: state.targets, revision }), /EMPTY_STATE/);
    } finally { state.close(); }
});
test('restore validates every hash before writing and rejects wrong revision and traversal', () => {
    const state = fixture();
    try {
        writeFileSync(join(state.sources.bot, 'offset.json'), '{"offset":7}');
        exportState({ sources: state.sources, destination: state.destination, revision });
        assert.throws(() => restoreState({ snapshot: state.destination, targets: state.targets, revision: 'b'.repeat(40) }));
        writeFileSync(join(state.destination, 'bot', 'offset.json'), 'tampered');
        assert.throws(() => restoreState({ snapshot: state.destination, targets: state.targets, revision }), /HASH/);
        assert.equal(existsSync(join(state.targets.bot, 'offset.json')), false);
        const manifest = JSON.parse(readFileSync(join(state.destination, 'manifest.json'), 'utf8')); manifest.files[0].name = '../escape';
        writeFileSync(join(state.destination, 'manifest.json'), JSON.stringify(manifest));
        assert.throws(() => restoreState({ snapshot: state.destination, targets: state.targets, revision }));
    } finally { state.close(); }
});
