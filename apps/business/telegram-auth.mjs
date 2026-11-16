import { createPublicKey, verify, createHash } from 'node:crypto';

// Telegram's production Ed25519 public key. No bot token is needed by the portal.
const telegramKey = createPublicKey({ key: Buffer.from('302a300506032b6570032100e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d', 'hex'), format: 'der', type: 'spki' });
export function verifyTelegramLaunch(initData, botId, { now = Date.now, publicKey = telegramKey } = {}) {
    const fail = () => { throw new Error('TELEGRAM_LOGIN_REJECTED'); };
    if (typeof initData !== 'string' || Buffer.byteLength(initData) > 3500 || !Number.isSafeInteger(botId) || botId <= 0) fail();
    const fields = new URLSearchParams(initData); const entries = [...fields];
    if (entries.length > 20 || new Set(entries.map(([key]) => key)).size !== entries.length || entries.some(([key, value]) => !/^[a-z_]{1,40}$/.test(key) || /[\r\n]/.test(value))) fail();
    const signature = fields.get('signature'); const date = fields.get('auth_date');
    if (!/^[A-Za-z0-9_-]{86}(?:==)?$/.test(signature ?? '') || !/^[1-9]\d{8,11}$/.test(date ?? '')) fail();
    const authDate = Number(date) * 1000;
    if (authDate > now() + 15000 || authDate < now() - 300000) fail();
    const check = botId + ':WebAppData\n' + entries.filter(([key]) => !['hash', 'signature'].includes(key)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => key + '=' + value).join('\n');
    if (!verify(null, Buffer.from(check), publicKey, Buffer.from(signature, 'base64url'))) fail();
    let user; try { user = JSON.parse(fields.get('user')); } catch { fail(); }
    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || user.is_bot === true || typeof user.first_name !== 'string' || user.first_name.length > 256 || (user.last_name !== undefined && (typeof user.last_name !== 'string' || user.last_name.length > 256))) fail();
    return { profile: { telegramId: user.id, firstName: user.first_name, lastName: user.last_name ?? '' }, authDate, digest: createHash('sha256').update(check).update(Buffer.from(signature, 'base64url')).digest('hex') };
}
