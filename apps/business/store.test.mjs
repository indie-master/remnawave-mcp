import test from 'node:test';
import assert from 'node:assert/strict';
import { createBusinessStore, createSupport, redactSupport } from './store.mjs';
import { validateSupportInput, validateSupportReply } from '../telegram-admin/support-policy.mjs';
import { createCodexClassifier } from '../telegram-admin/codex-classifier.mjs';
const password = 'synthetic-password-only';
function fixture() {
    let time = Date.parse('2026-10-16T10:00:00Z');
    const store = createBusinessStore({ filename: ':memory:', now: () => time });
    const first = store.provision('first@example.invalid', password, 1).id;
    const second = store.provision('second@example.invalid', password, 2).id;
    return { store, first, second, advance: () => { time += 60001; } };
}
test('email/password sessions are opaque, expiring and login attempts are rate bounded', () => {
    const { store } = fixture();
    try {
        assert.throws(() => store.login('first@example.invalid', 'incorrect', 'local'));
        const session = store.login('first@example.invalid', password, 'local');
        assert.equal(store.session(session.token).account, session.accountId);
        assert.equal(store.session(session.token).password, undefined);
        store.logout(session.token); assert.throws(() => store.session(session.token));
        for (let attempt = 0; attempt < 6; attempt++) assert.throws(() => store.login('unknown@example.invalid', password, 'local'));
    } finally { store.close(); }
});
test('manual RUB/USDT payments do not credit before human approval and never credit twice', () => {
    const { store, first, second } = fixture();
    try {
        const payment = store.payment(first, 'RUB', 12345);
        assert.equal(store.account(first).balances.RUB, 0);
        assert.equal(store.payments(second).length, 0);
        store.approvePayment(payment.id, 'test:receipt1'); assert.equal(store.account(first).balances.RUB, 12345);
        assert.throws(() => store.approvePayment(payment.id, 'test:receipt1')); assert.equal(store.account(first).balances.RUB, 12345);
        const duplicate = store.payment(second, 'RUB', 12345); assert.throws(() => store.approvePayment(duplicate.id, 'test:receipt1')); assert.equal(store.account(second).balances.RUB, 0);
        const crypto = store.payment(first, 'USDT', 1000000); store.approvePayment(crypto.id, 'test:receipt2');
        assert.equal(store.account(first).balances.USDT, 1000000); assert.equal(store.account(second).balances.USDT, 0);
        for (const [currency, units] of [['USD', 1], ['RUB', -1], ['USDT', 0.1]]) assert.throws(() => store.payment(first, currency, units));
    } finally { store.close(); }
});
test('support histories/private cache are account isolated and never enter shared knowledge', async () => {
    const { store, first, second } = fixture();
    try {
        store.append(first, 'user', 'личная история'); store.cache(first, 'самостоятельный подробный вопрос про подключение', 'личный ответ');
        assert.deepEqual(store.history(second), []); assert.equal(store.cached(first, 'самостоятельный подробный вопрос про подключение'), 'личный ответ'); assert.equal(store.cached(second, 'самостоятельный подробный вопрос про подключение'), undefined); assert.deepEqual(store.knowledge('самостоятельный подробный вопрос про подключение'), []);
        store.addKnowledge('test', ['не работает'], 'Уточните приложение и систему.');
        let calls = 0; const support = createSupport({ store, answer: async () => { calls++; } });
        assert.equal((await support(second, 'НЕ РАБОТАЕТ!')).source, 'knowledge'); assert.equal(calls, 0);
        store.eraseHistory(first); assert.deepEqual(store.history(first), []); assert.equal(store.cached(first, 'контекст вопроса'), undefined);
    } finally { store.close(); }
});
test('support sends only scoped history/minimized data, and unknowns hand off without guessing', async () => {
    const { store, first, second } = fixture();
    try {
        store.append(first, 'user', 'private first conversation'); let received;
        const support = createSupport({ store, answer: async value => { received = value; return { reply: 'Уточните приложение.', needsHuman: true }; } });
        const result = await support(second, 'Моя почта second@example.invalid ссылка https://example.invalid/secret');
        assert.equal(result.needsHuman, true);
        assert.ok(!JSON.stringify(received).includes('private first')); assert.ok(!JSON.stringify(received).includes('second@')); assert.ok(!JSON.stringify(received).includes('https:'));
        assert.equal(redactSupport('https://example.invalid/x'), '[скрыто]');
        const fallback = createSupport({ store }); assert.equal((await fallback(first, 'Неизвестный вопрос')).source, 'human');
    } finally { store.close(); }
});
test('support uses isolated no-tool CLI schema and strict usage guards, no live inference', async () => {
    const input = { question: 'Как подключиться?', history: [], knowledge: [] };
    validateSupportInput(input);
    assert.throws(() => validateSupportInput({ ...input, account: 'other' }));
    assert.throws(() => validateSupportReply({ reply: 'https://example.invalid', needsHuman: false }));
    let options;
    const responder = createCodexClassifier({ support: true, run: async value => {
        options = value;
        return [{ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ reply: 'Уточните приложение и систему.', needsHuman: true }) } }, { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 15 } }].map(value => JSON.stringify(value)).join('\n');
    } });
    assert.equal((await responder(input)).needsHuman, true);
    assert.ok(options.args.some(value => value.endsWith('support.schema.json'))); assert.ok(options.args.includes('mcp_servers={}')); assert.ok(options.args.includes('web_search="disabled"'));
});

test('support bounds UTF-8 context before inference and preserves the latest scoped history', async () => {
    const { store, first, second } = fixture();
    try {
        for (let index = 0; index < 6; index++) store.append(first, index % 2 ? 'assistant' : 'user', `история ${index} ` + 'я'.repeat(290));
        store.append(second, 'user', 'чужая история');
        for (let index = 0; index < 4; index++) store.addKnowledge(`faq-${index}`, [`знание-${index}`], 'я'.repeat(300));
        const oversized = { question: 'я'.repeat(500), history: store.history(first), knowledge: store.snippets() };
        assert.ok(JSON.stringify(oversized).length < 4096);
        assert.ok(Buffer.byteLength(JSON.stringify(oversized), 'utf8') > 4096);
        assert.throws(() => validateSupportInput(oversized), /AI_TEXT_REJECTED/);
        let received;
        const support = createSupport({ store, answer: async value => { received = value; validateSupportInput(value); return { reply: 'Уточните систему.', needsHuman: false }; } });
        assert.equal((await support(first, 'я'.repeat(500))).source, 'ai');
        assert.ok(Buffer.byteLength(JSON.stringify(received), 'utf8') <= 4096);
        assert.equal(received.question, 'я'.repeat(500));
        assert.ok(received.history.at(-1).text.startsWith('история 5'));
        assert.doesNotMatch(JSON.stringify(received), /чужая история/);
    } finally { store.close(); }
});

test('renewals reserve a fixed price once, refund only a rejected write and hold uncertain results', () => {
    const { store, first } = fixture();
    try {
        const deposit = store.payment(first, 'RUB', 10000); store.approvePayment(deposit.id, 'test:deposit');
        const renewal = store.requestRenewal(first, 'RUB', { units: 3000, days: 30 });
        assert.equal(store.account(first).balances.RUB, 10000);
        store.reserveRenewal(renewal.id, 'A'.repeat(16)); assert.equal(store.account(first).balances.RUB, 7000);
        assert.throws(() => store.reserveRenewal(renewal.id, 'A'.repeat(16)));
        store.settleRenewal(renewal.id, 'rejected'); assert.equal(store.account(first).balances.RUB, 10000);
        assert.throws(() => store.settleRenewal(renewal.id, 'rejected'));
        const uncertain = store.requestRenewal(first, 'RUB', { units: 3000, days: 30 }); store.reserveRenewal(uncertain.id, 'B'.repeat(16));
        store.settleRenewal(uncertain.id, 'uncertain'); assert.equal(store.account(first).balances.RUB, 7000);
        assert.throws(() => store.settleRenewal(uncertain.id, 'rejected'));
        assert.throws(() => store.requestRenewal(first, 'USDT', { units: 1000000, days: 30 }), /BALANCE/);
    } finally { store.close(); }
});
