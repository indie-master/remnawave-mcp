import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBusinessStore, createSupport } from './store.mjs';

function fixture(filename = ':memory:') {
    const store = createBusinessStore({ filename });
    const first = store.provision('first@example.invalid', 'synthetic-password-only', 48).id;
    const second = store.provision('second@example.invalid', 'synthetic-password-only', 49).id;
    return { store, first, second };
}

test('open support chat accepts follow-ups without repeated handoff messages, inference, or shared context', async () => {
    const { store, first, second } = fixture(); let calls = 0;
    const support = createSupport({ store, answer: async () => { calls++; throw new Error('SYNTHETIC_UNAVAILABLE'); } });
    try {
        await support(first, 'Неизвестная проблема');
        const ticket = store.openSupport(first);
        await support(first, 'Приложение и система уже названы');
        await support(first, 'Дополнительное уточнение');
        assert.equal(calls, 1); assert.equal(store.openSupport(first), ticket);
        assert.equal(store.supportHistory(first).filter(item => item.role === 'assistant').length, 1);
        assert.equal(store.supportHistory(first).filter(item => item.role === 'user').length, 3);
        assert.deepEqual(store.supportHistory(second), []);
        assert.doesNotMatch(JSON.stringify(store.supportHistory(first)), /Укажите приложение|не присылайте пароль/);
        for (let index = 0; index < 8; index++) await support(first, 'Следующее уточнение ' + index);
        await assert.rejects(support(first, 'Слишком много сообщений'), /SUPPORT_RATE_LIMIT/);
        assert.equal(calls, 1);
    } finally { store.close(); }
});

test('native replies keep a customer chat open and only explicit current-version close resolves it', () => {
    const { store, first, second } = fixture();
    try {
        store.append(first, 'user', 'Первый вопрос'); const ticket = store.handoff(first);
        const original = store.supportThread(ticket);
        assert.equal(original.panelId, 48);
        store.supportMessage(ticket, 'a'.repeat(32), 'Первый ответ администратора');
        store.supportMessage(ticket, 'b'.repeat(32), 'Второе сообщение');
        assert.equal(store.openSupport(first), ticket); assert.equal(store.pendingSupport().length, 1);
        assert.throws(() => store.closeSupport(ticket, original.version), /CHANGED/);
        assert.deepEqual(store.supportHistory(second), []);
        assert.equal(store.closeSupport(ticket, store.supportThread(ticket).version).closed, true);
        assert.equal(store.openSupport(first), undefined);
        assert.throws(() => store.supportMessage(ticket, 'c'.repeat(32), 'Ответ в закрытый диалог'));
        assert.notEqual(store.handoff(first), ticket);
    } finally { store.close(); }
});

test('reply receipts survive reopen and cannot replay another text or customer', () => {
    const filename = join(mkdtempSync(join(tmpdir(), 'support-chat-')), 'business.sqlite');
    const { store, first, second } = fixture(filename); const key = 'c'.repeat(32);
    const ticket = store.handoff(first); const other = store.handoff(second);
    store.supportMessage(ticket, key, 'Единственный ответ'); store.close();
    const reopened = createBusinessStore({ filename });
    try {
        assert.equal(reopened.supportMessage(ticket, key, 'Единственный ответ').replayed, true);
        assert.equal(reopened.supportHistory(first).length, 1);
        assert.throws(() => reopened.supportMessage(ticket, key, 'Другой ответ'));
        assert.throws(() => reopened.supportMessage(other, key, 'Единственный ответ'));
        assert.deepEqual(reopened.supportHistory(second), []);
        assert.throws(() => reopened.supportMessage(ticket, 'invalid', 'Текст'));
        assert.throws(() => reopened.supportMessage(ticket, 'd'.repeat(32), 'я'.repeat(501)));
    } finally { reopened.close(); }
});

test('customer chat history is broader than AI context and stays bounded and account scoped', () => {
    const { store, first, second } = fixture();
    try {
        for (let index = 0; index < 70; index++) store.append(first, index % 2 ? 'assistant' : 'user', 'Сообщение ' + index);
        assert.equal(store.history(first).length, 6); assert.equal(store.supportHistory(first).length, 50);
        assert.equal(store.supportHistory(first)[0].text, 'Сообщение 20');
        assert.deepEqual(store.supportHistory(second), []);
        store.eraseHistory(first); assert.deepEqual(store.supportHistory(first), []);
    } finally { store.close(); }
});
