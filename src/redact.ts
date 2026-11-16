import { createHmac, randomBytes } from 'node:crypto';

/**
 * Privacy filter for everything the server sends to the chat.
 *
 * REMNAWAVE_PRIVACY:
 *   strict (default) — credentials hidden + client personal data replaced by pseudonyms;
 *   basic            — only credentials hidden;
 *   off              — raw API responses (not recommended).
 *
 * Credentials (always hidden unless "off"): Reality private keys, node SECRET_KEY, passwords,
 * API keys, user VLESS UUID, subscription links and anything that looks like vless:// ss:// … links.
 * Also inside Xray configs (profiles, snippets, templates): the shortId of a Reality outbound, the user id of
 * VLESS/VMess outbounds (settings.id, vnext[].users[].id) and the Hysteria auth string — with these and a public
 * key anyone can connect through the cascade.
 *
 * Personal data (strict): username, email, Telegram ID, user description, IP addresses, HWID,
 * computer names in device models (DESKTOP-…) →
 * stable pseudonyms like "user~3fa2c1", "ip~91b0d4". The same value always gets the same pseudonym
 * while the server runs, so the model can still say "these two users share an IP" without seeing it.
 * Pseudonyms can be passed back as tool arguments — the server swaps them for the real values
 * locally, so the real data never goes through the chat.
 * Subscription short UUID / URL of users are hidden in strict and basic: they give access to the config.
 */

export type PrivacyMode = 'strict' | 'basic' | 'off';

const MASK = '[hidden]';
const SECRET_KEY_RE = /(private_?key|secret|passw(or)?d|api_?key|token$|^vlessUuid$|^shortId$)/i;
/** Hysteria "auth" is a credential; SOCKS inbounds use the same key for the mode name (noauth / password) */
const AUTH_MODES = new Set(['noauth', 'password']);
/** an object with one of these keys is a proxy account (outbound settings, vnext user) — its "id" is a credential */
const ACCOUNT_MARKERS = ['flow', 'encryption', 'alterId'];
/** Reality short IDs are part of the handshake auth — hide them as well */
const SECRET_LIST_KEYS = new Set(['shortIds']);
/** IPv4 / IPv6, optionally with a CIDR mask or a port; values like "geoip:private" in Xray rules are left alone */
const IPV4 = '\\d{1,3}(?:\\.\\d{1,3}){3}';
const IPV6 = '[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}';
const IP_RE = new RegExp(`^(?:(${IPV4})(?::(\\d{1,5}))?|\\[(${IPV6})\\]:(\\d{1,5})|(${IPV6}))(\\/\\d{1,3})?$`, 'i');
/** `source` — client address in torrent-blocker reports (Xray log), often "ip:port" */
const IP_FIELDS = new Set(['ip', 'ips', 'requestIp', 'ipAddresses', 'source']);
/** credentials inside any URL, e.g. a node proxy "socks5://user:pass@host:port" */
const URL_CRED_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
/** IPv6 in free text: at least two colons and either "::" or a hex letter (so times like 12:30:45 stay) */
const IPV6_TEXT_RE = /(?<![\w:])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![\w:])/gi;
/** long device identifiers inside user agents, e.g. Happ/4.4.1/Android/17891107313301967618 */
const UA_ID_RE = /\b[0-9a-f]{12,}\b/gi;
const LINK_ARRAYS = new Set(['links', 'ssConfLinks']);
const LINK_RE = /\b(vless|vmess|trojan|ss|ssr|hysteria2?|hy2|tuic|wireguard|wg):\/\/\S+/gi;

/** personal-data field → pseudonym prefix */
const PII_FIELDS: Record<string, string> = {
    username: 'user',
    email: 'email',
    allowedEmails: 'email',
    telegramId: 'tg',
    ip: 'ip',
    ips: 'ip',
    requestIp: 'ip',
    ipAddresses: 'ip',
    hwid: 'hwid',
};
/** subscription short UUID / URL give access to the client's config → hidden wherever they appear
 *  (user objects, subscription responses `{ user: {...}, subscriptionUrl }`, anything else) */
const SUBSCRIPTION_KEYS = new Set(['shortUuid', 'subscriptionUrl']);
const USER_ONLY_PSEUDO: Record<string, string> = { description: 'note' };

export class Privacy {
    private salt: Buffer;
    private reverse = new Map<string, unknown>();
    private forward = new Map<string, string>();

    constructor(
        public mode: PrivacyMode,
        salt?: string,
    ) {
        this.salt = salt ? Buffer.from(salt) : randomBytes(32);
    }

    private pseudo(prefix: string, value: unknown): unknown {
        if (value === null || value === undefined || value === '') return value;
        if (Array.isArray(value)) return value.map((v) => this.pseudo(prefix, v));
        if (typeof value === 'object') return this.apply(value); // e.g. ips: [{ ip, lastSeen }]
        const key = `${prefix}\u0000${String(value)}`;
        const known = this.forward.get(key);
        if (known) return known;
        const hash = createHmac('sha256', this.salt).update(String(value)).digest('hex');
        // 6 hex chars are enough to read; on a rare collision with another value the new one gets a longer token,
        // so equal pseudonyms always mean equal values and a pseudonym is always restored to the right value
        let token = `${prefix}~${hash.slice(0, 6)}`;
        for (let len = 10; this.reverse.has(token) && String(this.reverse.get(token)) !== String(value) && len <= 64; len += 4)
            token = `${prefix}~${hash.slice(0, len)}`;
        this.reverse.set(token, value);
        this.forward.set(key, token);
        return token;
    }

    /** Replace a computer name in a device model with a pseudonym, keep the architecture suffix. */
    private pcName(model: string, platform: unknown): string {
        const looksLikeHost = /^(DESKTOP|LAPTOP|WIN|PC)-[A-Z0-9]+/i.test(model) || /windows|linux/i.test(String(platform ?? ''));
        if (!looksLikeHost) return model;
        const m = model.match(/^(.*?)(_(x86_64|amd64|arm64|aarch64|x86|i[3-6]86))?$/i);
        const host = m?.[1] ?? model;
        return `${this.pseudo('host', host)}${m?.[2] ?? ''}`;
    }

    /** Pseudonymize only real IP addresses (Xray rules use the same "ip" key for geoip:… lists). */
    private pseudoIp(value: unknown): unknown {
        if (typeof value === 'string') {
            const m = value.match(IP_RE);
            if (!m) return value;
            // keep the port / mask visible, pseudonymize only the address — so "1.2.3.4:5555" and "1.2.3.4" match
            const host = m[1] ?? m[3] ?? m[5];
            const port = m[2] ?? m[4];
            return `${this.pseudo('ip', host)}${port ? `:${port}` : ''}${m[6] ?? ''}`;
        }
        if (Array.isArray(value)) return value.map((v) => this.pseudoIp(v));
        if (value && typeof value === 'object') return this.apply(value);
        return value;
    }

    /** Filter an API response before it goes to the chat. */
    apply(value: unknown, key = '', inUser = false): unknown {
        if (this.mode === 'off' || value === null || value === undefined) return value;
        const strict = this.mode === 'strict';

        if (key && SECRET_KEY_RE.test(key)) {
            return value === '' ? value : MASK;
        }
        if (key === 'auth' && typeof value === 'string' && value !== '' && !AUTH_MODES.has(value)) return MASK;
        if (key && SECRET_LIST_KEYS.has(key) && Array.isArray(value)) {
            return value.map((v) => (v === '' ? v : MASK));
        }
        if (key && LINK_ARRAYS.has(key) && typeof value === 'object') {
            return Array.isArray(value) ? `${MASK} (${value.length} links)` : MASK;
        }
        if (key && SUBSCRIPTION_KEYS.has(key) && typeof value === 'string') return value === '' ? value : MASK;
        if (strict && key) {
            if (IP_FIELDS.has(key)) return this.pseudoIp(value);
            if (key in PII_FIELDS) return this.pseudo(PII_FIELDS[key], value);
            if (key === 'userAgent' && typeof value === 'string')
                return value.replace(UA_ID_RE, (m) => String(this.pseudo('hwid', m)));
            if (inUser && key in USER_ONLY_PSEUDO && typeof value === 'string')
                return this.pseudo(USER_ONLY_PSEUDO[key], value);
        }
        if (typeof value === 'string') {
            if (/^\s*[\[{]/.test(value)) {
                try {
                    return JSON.stringify(this.apply(JSON.parse(value), '', inUser));
                } catch {
                    if (value.trimStart().startsWith('{')) return MASK;
                }
            }
            return value.replace(LINK_RE, (_m, p: string) => `${p}://${MASK}`).replace(URL_CRED_RE, `$1${MASK}@`);
        }
        if (Array.isArray(value)) return value.map((v) => this.apply(v, '', inUser));
        if (typeof value === 'object') {
            const obj = value as Record<string, unknown>;
            // user object: has a subscription short UUID or traffic/expiry fields of a user
            const isUser = inUser || ('shortUuid' in obj && ['expireAt', 'expiresAt', 'status', 'userStatus'].some((k) => k in obj));
            const isAccount = typeof obj.id === 'string' && ACCOUNT_MARKERS.some((m) => m in obj);
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(obj)) out[k] = isAccount && k === 'id' ? MASK : this.apply(v, k, isUser);
            // HWID device of a computer: deviceModel carries the computer name, e.g. "DESKTOP-QQNA3B4_x86_64"
            if (strict && typeof obj.deviceModel === 'string' && 'hwid' in obj) out.deviceModel = this.pcName(obj.deviceModel, obj.platform);
            return out;
        }
        return value;
    }

    /**
     * Filter free text (error messages from the panel): connection links are masked, and in strict mode
     * IP addresses, e-mails and any value already known under a pseudonym are replaced as well.
     */
    text(value: string): string {
        if (this.mode === 'off') return value;
        let out = value.replace(LINK_RE, (_m, p: string) => `${p}://${MASK}`).replace(URL_CRED_RE, `$1${MASK}@`);
        if (this.mode !== 'strict') return out;
        out = out.replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, (m) => String(this.pseudo('ip', m)));
        out = out.replace(IPV6_TEXT_RE, (m) => (m.includes('::') || /[a-f]/i.test(m) ? String(this.pseudo('ip', m)) : m));
        out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, (m) => String(this.pseudo('email', m)));
        for (const [token, real] of this.reverse) {
            const r = String(real);
            if (r.length >= 4 && out.includes(r)) out = out.split(r).join(token);
        }
        return out;
    }

    /** Swap pseudonyms in tool arguments back to real values (locally, never through the chat). */
    restore(value: unknown): unknown {
        if (this.mode !== 'strict') return value;
        if (typeof value === 'string') return this.reverse.has(value) ? this.reverse.get(value) : value;
        if (Array.isArray(value)) return value.map((v) => this.restore(v));
        if (value && typeof value === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = this.restore(v);
            return out;
        }
        return value;
    }
}
