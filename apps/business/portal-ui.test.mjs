import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';

const html = readFileSync(new URL('./portal.html', import.meta.url), 'utf8');
const source = html.match(/<script nonce="__NONCE__">([\s\S]*?)<\/script>/)[1];
function browser(account) {
    class Element {
        constructor(id = '') { this.id = id; this.value = ''; this.textContent = ''; this.disabled = false; this.children = []; this.classes = new Set(); this.classList = { add: value => this.classes.add(value), remove: value => this.classes.delete(value), toggle: (value, enabled) => enabled ? this.classes.add(value) : this.classes.delete(value) }; }
        append(...values) { this.children.push(...values); if (this.id === 'renewalPlan' && !this.value) this.value = values[0].value; }
        replaceChildren() { this.children = []; this.textContent = ''; if (this.id === 'renewalPlan') this.value = ''; }
        setAttribute() {} removeAttribute() {}
    }
    const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(value => [value[1], new Element(value[1])]));
    const buttons = [...html.matchAll(/<button(?: id="([^"]+)")?/g)].map(value => elements[value[1]] ?? new Element());
    const calls = []; let next;
    const context = createContext({ document: { getElementById: id => elements[id], createElement: () => new Element(), querySelectorAll: () => buttons, body: new Element() }, location: { reload() {} }, URL, fetch: async (path, options) => {
        calls.push({ path, options });
        if (next) { const reply = next; next = undefined; return reply; }
        return { ok: true, json: async () => account };
    } });
    new Script(source).runInContext(context);
    return { elements, calls, respond: response => { next = response; }, settle: () => new Promise(setImmediate) };
}
const account = (features, plans = []) => ({ email: 'pilot@example.invalid', csrf: 'synthetic-csrf', balances: { RUB: 0, USDT: 0 }, payments: [], renewals: [], history: [], features, plans });

test('customer screen hides disabled billing and panel actions without losing local support', async () => {
    const page = browser(account({ billing: false, panel: false, media: false })); await page.settle();
    for (const id of ['paymentSection', 'renewalSection', 'subscription', 'mediaForm']) assert.ok(page.elements[id].classes.has('hidden'));
    assert.ok(!page.elements.account.classes.has('hidden'));
    assert.equal(page.elements.renew.disabled, true);
    assert.equal(typeof page.elements.supportForm.onsubmit, 'function');
    assert.equal(page.calls.length, 1);
});

test('customer renewal sends the displayed quote once and expired sessions remove private content', async () => {
    const page = browser(account({ billing: true, panel: true, media: false }, [{ currency: 'RUB', units: 12345, days: 30 }])); await page.settle();
    assert.equal(page.elements.renewalPlan.children.length, 1);
    assert.match(page.elements.planDetails.textContent, /30 дн\..*123,45 RUB/);
    assert.equal(page.elements.renew.disabled, false);
    const first = page.elements.renew.onclick(); const duplicate = page.elements.renew.onclick();
    await Promise.all([first, duplicate]);
    const renewals = page.calls.filter(call => call.path === '/api/renewal');
    assert.equal(renewals.length, 1);
    assert.deepEqual(JSON.parse(renewals[0].options.body), { currency: 'RUB', units: 12345, days: 30 });
    page.elements.subscriptionDetails.textContent = 'private subscription';
    page.elements.sources.textContent = 'private sources';
    page.elements.question.value = 'private question';
    page.respond({ ok: false, json: async () => ({ code: 'SESSION_EXPIRED' }) });
    await page.elements.subscription.onclick();
    assert.ok(page.elements.account.classes.has('hidden')); assert.ok(!page.elements.login.classes.has('hidden'));
    for (const id of ['details', 'history', 'payments', 'renewals', 'subscriptionDetails', 'sources', 'planDetails']) assert.equal(page.elements[id].textContent, '');
    assert.equal(page.elements.question.value, ''); assert.equal(page.elements.renew.disabled, true);
    assert.match(page.elements.status.textContent, /Войдите заново/);
});
