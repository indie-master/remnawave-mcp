import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';

const html = readFileSync(new URL('./portal.html', import.meta.url), 'utf8');
const source = html.match(/<script nonce="__NONCE__">([\s\S]*?)<\/script>/)[1];
function browser(account, miniApp) {
    class Element {
        constructor(id = '') { this.id = id; this.value = ''; this.textContent = ''; this.disabled = false; this.children = []; this.classes = new Set(); this.classList = { add: value => this.classes.add(value), remove: value => this.classes.delete(value), toggle: (value, enabled) => enabled ? this.classes.add(value) : this.classes.delete(value) }; }
        append(...values) { this.children.push(...values); if (this.id === 'renewalPlan' && !this.value) this.value = values[0].value; }
        replaceChildren() { this.children = []; this.textContent = ''; if (this.id === 'renewalPlan') this.value = ''; }
        setAttribute() {} removeAttribute() {}
    }
    const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(value => [value[1], new Element(value[1])]));
    const buttons = [...html.matchAll(/<button(?: id="([^"]+)")?/g)].map(value => elements[value[1]] ?? new Element());
    const calls = []; let next; let poll;
    const document = { visibilityState: 'visible', getElementById: id => elements[id], createElement: () => new Element(), querySelectorAll: () => buttons, body: new Element() };
    const context = createContext({ ...(miniApp ? { window: { Telegram: { WebApp: miniApp } } } : {}), document, setInterval: (callback, milliseconds) => { assert.equal(milliseconds, 5000); poll = callback; }, location: { reload() {} }, URL, fetch: async (path, options) => {
        calls.push({ path, options });
        if (next) { const reply = next; next = undefined; return reply; }
        return { ok: true, json: async () => account };
    } });
    new Script(source).runInContext(context);
    return { elements, calls, document, poll: () => poll(), respond: response => { next = response; }, settle: () => new Promise(setImmediate) };
}
const account = (features, plans = []) => ({ email: 'pilot@example.invalid', csrf: 'synthetic-csrf', balances: { RUB: 0, USDT: 0 }, payments: [], renewals: [], history: [], features, plans });

test('Mini App uses only signed initData and shows email connection for a Telegram-first account', async () => {
    let ready = 0; let expand = 0;
    const value = { ...account({ billing: false, panel: false, media: false }), sessionKey: 'a'.repeat(64), email: null, panelId: null, profileName: 'Тест Клиент' };
    const page = browser(value, { initData: 'synthetic-signed-launch', initDataUnsafe: { user: { id: 'must-not-trust' } }, ready: () => ready++, expand: () => expand++ }); await page.settle();
    assert.equal(ready, 1); assert.equal(expand, 1);
    assert.equal(page.calls[0].path, '/api/telegram-login');
    assert.deepEqual(JSON.parse(page.calls[0].options.body), { initData: 'synthetic-signed-launch' });
    assert.equal(page.calls[1].options.headers.Authorization, 'Bearer ' + 'a'.repeat(64));
    assert.ok(!page.elements.emailSection.classes.has('hidden')); assert.match(page.elements.details.textContent, /Тест Клиент/);
    page.elements.emailMode.value = 'existing'; page.elements.connectEmail.value = 'existing@example.invalid'; page.elements.connectPassword.value = 'synthetic-password-only';
    await page.elements.emailConnectForm.onsubmit({ preventDefault() {} }); await page.settle();
    assert.equal(page.calls.find(value => value.path === '/api/email-connect').options.method, 'POST');
    assert.equal(page.elements.connectPassword.value, '');
    page.respond({ ok: false, json: async () => ({ code: 'SESSION_EXPIRED' }) }); await page.poll();
    assert.ok(page.elements.emailSection.classes.has('hidden')); assert.equal(page.elements.connectEmail.value, '');
});

test('customer screen hides disabled billing and panel actions without losing local support', async () => {
    const page = browser(account({ billing: false, panel: false, media: false })); await page.settle();
    for (const id of ['paymentSection', 'renewalSection', 'subscription', 'mediaForm']) assert.ok(page.elements[id].classes.has('hidden'));
    assert.ok(!page.elements.account.classes.has('hidden'));
    assert.equal(page.elements.renew.disabled, true);
    assert.equal(typeof page.elements.supportForm.onsubmit, 'function');
    assert.equal(page.calls.length, 1);
});

test('visible customer chat receives native answers without reloading or reading panel data', async () => {
    const page = browser(account({ billing: false, panel: false, media: false })); await page.settle();
    page.respond({ ok: true, json: async () => ({ state: 'open', history: [{ role: 'assistant', text: '<Ответ администратора>' }] }) });
    await page.poll();
    assert.equal(page.calls.at(-1).path, '/api/support');
    assert.equal(page.elements.history.children[0].children[1].textContent, '<Ответ администратора>');
    assert.match(page.elements.supportState.textContent, /открыт/);
    assert.equal(page.calls.filter(value => value.path === '/api/subscription').length, 0);
    page.document.visibilityState = 'hidden'; const count = page.calls.length;
    await page.poll(); assert.equal(page.calls.length, count);
    page.document.visibilityState = 'visible';
    page.respond({ ok: false, json: async () => ({ code: 'SESSION_EXPIRED' }) });
    await page.poll(); assert.equal(page.elements.history.children.length, 0);
    await page.poll(); assert.equal(page.calls.length, count + 1);
});

test('Telegram link is shown only for the enabled customer bot and disappears after binding or session expiry', async () => {
    const value = account({ billing: false, panel: false, media: false }); value.telegram = { enabled: true, linked: false, botUsername: 'example_customer_bot' };
    const page = browser(value); await page.settle();
    assert.ok(!page.elements.telegramSection.classes.has('hidden'));
    page.respond({ ok: true, json: async () => ({ url: 'https://t.me/example_customer_bot?start=' + 'x'.repeat(32), expiresAt: Date.now() + 300000 }) });
    await page.elements.telegramLink.onclick(); assert.ok(!page.elements.telegramOpen.classes.has('hidden'));
    page.respond({ ok: true, json: async () => ({ state: 'closed', history: [], telegram: { enabled: true, linked: true } }) });
    await page.poll(); assert.equal(page.elements.telegramOpen.href, ''); assert.ok(!page.elements.telegramUnlink.classes.has('hidden'));
    page.respond({ ok: false, json: async () => ({ code: 'SESSION_EXPIRED' }) }); await page.poll();
    assert.ok(page.elements.telegramSection.classes.has('hidden')); assert.equal(page.elements.telegramOpen.href, '');
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
