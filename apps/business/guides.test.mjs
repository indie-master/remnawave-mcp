import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGuideLibrary } from './guides.mjs';
test('approved guides accept only bounded local PNG/JPEG assets and reject catalog traversal', () => {
    const directory = mkdtempSync(join(tmpdir(), 'approved-guides-'));
    try {
        const library = createGuideLibrary(directory); assert.deepEqual(library.list(), []);
        writeFileSync(join(directory, 'catalog.json'), JSON.stringify([{ id: 'test', title: 'Synthetic guide', file: 'test.png' }]));
        writeFileSync(join(directory, 'test.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        assert.equal(library.list()[0].title, 'Synthetic guide'); assert.equal(library.image('test').type, 'image/png');
        writeFileSync(join(directory, 'catalog.json'), JSON.stringify([{ id: 'test', title: 'Synthetic guide', file: '../private.txt' }]));
        assert.throws(() => library.image('test'));
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
