import test from 'node:test';
import assert from 'node:assert/strict';

test('credentials and personal data in JSON-encoded configuration strings are filtered', () => {
    const privacy = new Privacy('strict', 'test');
    const output = privacy.apply({ config: JSON.stringify({ privateKey: 'DEMO_PRIVATE', email: 'demo@example.invalid' }) });
    assert.ok(!JSON.stringify(output).includes('DEMO_PRIVATE'));
    assert.ok(!JSON.stringify(output).includes('demo@example.invalid'));
});

test('secret fields containing arrays are hidden as a whole', () => {
    const privacy = new Privacy('strict', 'test');
    assert.equal(privacy.apply({ accessToken: ['DEMO_TOKEN'] }).accessToken, '[hidden]');
});
import { Privacy } from '../dist/redact.js';
import { SECRETS, PII, user, configProfile, snippets, template, history, assertNoLeak } from './helpers.mjs';

const all = (o) => Object.values(o);

test('strict: no secrets and no personal data in a user object', () => {
    const out = JSON.stringify(new Privacy('strict').apply({ users: [user()] }));
    assertNoLeak(assert, out, [...all(SECRETS), PII.username, PII.email, PII.telegramId, PII.description]);
    assert.match(out, /user~[0-9a-f]{6}/);
    assert.match(out, /"id":5/);
    assert.match(out, /"tag":"VIP"/);
});

test('strict: config profiles hide keys, shortIds and passwords but keep geoip rules and public key', () => {
    const out = JSON.stringify(new Privacy('strict').apply(configProfile()));
    assertNoLeak(assert, out, [SECRETS.privateKey, SECRETS.shortId, SECRETS.realityPassword, SECRETS.salamander]);
    assert.ok(out.includes('geoip:private') && out.includes('geoip:telegram'));
    assert.ok(out.includes('PUBLIC_OK'));
    assert.ok(out.includes('"shortIds":["","[hidden]"]'));
});

test('snippets: cascade UUIDs, shortId and Hysteria auth are hidden, routing stays readable', () => {
    for (const mode of ['strict', 'basic']) {
        const out = JSON.stringify(new Privacy(mode).apply(snippets()));
        assertNoLeak(assert, out, [SECRETS.cascadeUuid, SECRETS.extUuid, SECRETS.shortId, SECRETS.hysteriaAuth, SECRETS.realityPassword]);
        assert.ok(out.includes('"tag":"outbound-ru-1"') && out.includes('"flow":"xtls-rprx-vision"'));
        assert.ok(out.includes('"selector":["outbound-ru"]') && out.includes('PUBLIC_OK'));
    }
});

test('templates: SOCKS auth mode is not treated as a secret', () => {
    const out = JSON.stringify(new Privacy('strict').apply(template()));
    assert.ok(out.includes('"auth":"noauth"'));
});

test('strict: IPs and device IDs in user agents become pseudonyms, equal values → equal pseudonyms', () => {
    const p = new Privacy('strict');
    const out = p.apply(history());
    const s = JSON.stringify(out);
    assertNoLeak(assert, s, [PII.ip, PII.uaDevice, '198.51.100.2']);
    assert.match(out.records[0].userAgent, /^Happ\/4\.4\.1\/Android\/hwid~[0-9a-f]{6}$/);
    assert.equal(p.apply({ ip: PII.ip }).ip, out.records[0].requestIp);
});

test('strict: pseudonyms passed back are restored locally', () => {
    const p = new Privacy('strict');
    const token = p.apply(user()).username;
    assert.deepEqual(p.restore({ username: token, n: 1, list: [token] }), { username: PII.username, n: 1, list: [PII.username] });
});

test('basic: secrets hidden, personal data visible', () => {
    const out = JSON.stringify(new Privacy('basic').apply(user()));
    assertNoLeak(assert, out, [SECRETS.vlessUuid, SECRETS.trojan, SECRETS.ss, SECRETS.shortUuid, SECRETS.subUrl]);
    assert.ok(out.includes(PII.username) && out.includes(PII.email));
});

test('off: raw data', () => {
    const out = JSON.stringify(new Privacy('off').apply(user()));
    assert.ok(out.includes(SECRETS.vlessUuid) && out.includes(PII.username));
});

test('connection links and node secret keys are hidden anywhere', () => {
    const out = JSON.stringify(
        new Privacy('basic').apply({ links: [SECRETS.link], ssConfLinks: { a: 'ss://x' }, note: `use ${SECRETS.link} now`, secretKey: SECRETS.secretKey }),
    );
    assertNoLeak(assert, out, [SECRETS.vlessUuid, SECRETS.secretKey, 'ss://x']);
});

test('error texts: links, IPs, e-mails and known values are scrubbed', () => {
    const p = new Privacy('strict');
    p.apply(user()); // makes the username known
    const msg = p.text(`User ${PII.username} (${PII.email}) from ${PII.ip} failed: ${SECRETS.link}`);
    assertNoLeak(assert, msg, [PII.username, PII.email, PII.ip, SECRETS.vlessUuid]);
});

test('strict: computer names in HWID device models become pseudonyms, phones stay as is', () => {
    const p = new Privacy('strict');
    const out = p.apply({ devices: [
        { hwid: 'h1', platform: 'Windows', deviceModel: 'DESKTOP-QQNA3B4_x86_64' },
        { hwid: 'h2', platform: 'iOS', deviceModel: 'iPhone 15 Pro Max' },
        { hwid: 'h3', platform: 'Linux', deviceModel: 'ivan-thinkpad' },
    ] });
    const s = JSON.stringify(out);
    assertNoLeak(assert, s, ['QQNA3B4', 'ivan-thinkpad']);
    assert.match(out.devices[0].deviceModel, /^host~[0-9a-f]{6}_x86_64$/);
    assert.equal(out.devices[1].deviceModel, 'iPhone 15 Pro Max');
    assert.equal(new Privacy('basic').apply({ hwid: 'h', platform: 'Windows', deviceModel: 'DESKTOP-X' }).deviceModel, 'DESKTOP-X');
});

test('subscription responses: shortUuid and subscription URL are hidden outside user objects too', () => {
    for (const mode of ['strict', 'basic']) {
        const out = JSON.stringify(new Privacy(mode).apply({
            isFound: true,
            user: { shortUuid: SECRETS.shortUuid, username: PII.username, expiresAt: '2026-10-01', userStatus: 'ACTIVE' },
            links: [SECRETS.link],
            subscriptionUrl: SECRETS.subUrl,
        }));
        assertNoLeak(assert, out, [SECRETS.shortUuid, SECRETS.subUrl, SECRETS.vlessUuid]);
        if (mode === 'strict') assertNoLeak(assert, out, [PII.username]);
    }
});

test('credentials inside URLs (node proxyUrl) are hidden, host stays readable', () => {
    const out = new Privacy('basic').apply({ proxyUrl: 'socks5://admin:S3cretPass@10.0.0.5:1080' });
    assert.equal(out.proxyUrl, 'socks5://[hidden]@10.0.0.5:1080');
    assert.ok(!new Privacy('strict').text('proxy socks5://admin:S3cretPass@host failed').includes('S3cretPass'));
});

test('IP with a port (torrent report source) gets the same pseudonym as the bare IP', () => {
    const p = new Privacy('strict');
    const out = p.apply({ report: { xrayReport: { source: `${PII.ip}:5555` }, actionReport: { ip: PII.ip } } });
    assert.equal(out.report.xrayReport.source, `${out.report.actionReport.ip}:5555`);
    assert.ok(!JSON.stringify(out).includes(PII.ip));
    assert.equal(p.apply({ source: 'xray' }).source, 'xray');
});

test('IPv6 in error texts is scrubbed, times are not', () => {
    const t = new Privacy('strict').text('client 2001:db8::7 failed at 12:30:45');
    assert.ok(!t.includes('2001:db8::7'));
    assert.ok(t.includes('12:30:45'));
});

test('any *Token key is a secret, counters like "tokens" are not', () => {
    const out = new Privacy('basic').apply({ config: { botToken: 'BOT_SECRET_1', apiToken: 'API_SECRET_2', tokens: 3 } });
    assertNoLeak(assert, JSON.stringify(out), ['BOT_SECRET_1', 'API_SECRET_2']);
    assert.equal(out.config.tokens, 3);
});

test('pseudonym collision: two values never share a pseudonym and each is restored correctly', async () => {
    const { createHmac } = await import('node:crypto');
    const salt = 'collision-test';
    const seen = new Map();
    let pair;
    for (let i = 0; !pair && i < 200000; i++) {
        const v = `user${i}`;
        const h = createHmac('sha256', Buffer.from(salt)).update(v).digest('hex').slice(0, 6);
        if (seen.has(h)) pair = [seen.get(h), v];
        else seen.set(h, v);
    }
    assert.ok(pair, 'no collision found');
    const p = new Privacy('strict', salt);
    const a = p.apply({ username: pair[0] }).username;
    const b = p.apply({ username: pair[1] }).username;
    assert.notEqual(a, b);
    assert.equal(p.apply({ username: pair[0] }).username, a);
    assert.equal(p.restore(a), pair[0]);
    assert.equal(p.restore(b), pair[1]);
});
