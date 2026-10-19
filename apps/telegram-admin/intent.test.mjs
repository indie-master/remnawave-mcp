import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateIntent } from './intent.mjs';

test('optional classifier plans permit only fixed read actions and supported windows', () => {
    for (const action of ['help', 'version', 'stats', 'nodes', 'expiring']) {
        for (const days of [1, 3, 7, 14, 30]) assert.deepEqual(validateIntent({ action, days }), { action, days });
    }
});

test('optional classifier cannot supply URLs, extra arguments, write actions or arbitrary periods', () => {
    for (const plan of [null, [], {}, { action: 'delete_user', days: 3 }, { action: 'stats', days: '3' }, { action: 'expiring', days: 999 }, { action: 'stats', days: 3, url: 'https://example.invalid' }])
        assert.throws(() => validateIntent(plan), /INVALID_AI_INTENT/);
});
