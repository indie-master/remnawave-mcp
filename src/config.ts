import { readFileSync } from 'node:fs';

export interface Config {
    baseUrl: string;
    headers: Record<string, string>;
    /** true — only tools with kind "read" are exposed */
    readonly: boolean;
    /** strict (default) | basic | off — see src/redact.ts */
    privacy: 'strict' | 'basic' | 'off';
    privacySalt?: string;
    /** privacy === 'off': credential-only tools are exposed too */
    showSecrets: boolean;
    exclude: Set<string>;
    include: Set<string> | null;
    maxResponseChars: number;
    maxResponseBytes?: number;
    /** compact JSON without nulls/duplicates (default true) */
    compact: boolean;
    /** max `size` for list requests (0 = no cap) */
    maxPageSize: number;
    /** minutes between repeated node jobs for the same target */
    cooldown: { geocheck: number; connections: number };
    timeoutMs: number;
}

function num(v: string | undefined, def: number): number {
    const n = Number(v);
    return v && Number.isFinite(n) && n >= 0 ? n : def;
}

function csv(v: string | undefined): string[] {
    return (v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

function secret(name: string): string | undefined {
    const value = process.env[name];
    const filename = process.env[`${name}_FILE`];
    if (value && filename) throw new Error(`Set either ${name} or ${name}_FILE, not both`);
    if (!filename) return value || undefined;
    let content: string;
    try {
        content = readFileSync(filename, 'utf8').trim();
    } catch {
        throw new Error(`Cannot read ${name}_FILE`);
    }
    if (!content) throw new Error(`${name}_FILE must not be empty`);
    return content;
}

export function loadConfig(): Config {
    const baseUrl = process.env.REMNAWAVE_BASE_URL;
    const apiToken = secret('REMNAWAVE_API_TOKEN');
    if (!baseUrl) throw new Error('REMNAWAVE_BASE_URL is required (e.g. https://panel.example.com)');
    if (!apiToken) throw new Error('REMNAWAVE_API_TOKEN is required');
    let parsedUrl: URL;
    try {
        parsedUrl = new URL(baseUrl);
    } catch {
        throw new Error('REMNAWAVE_BASE_URL must be an HTTP(S) URL');
    }
    if (!['https:', 'http:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash)
        throw new Error('REMNAWAVE_BASE_URL must be HTTP(S) without credentials, query or fragment');

    const headers: Record<string, string> = {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
    };
    const apiKey = secret('REMNAWAVE_API_KEY');
    if (apiKey) headers['X-Api-Key'] = apiKey;
    // Direct connection to the panel container (http://remnawave:3000 inside the Docker network):
    // the panel expects the headers a reverse proxy would normally add.
    if (/^http:\/\//i.test(baseUrl)) {
        headers['X-Forwarded-Proto'] = 'https';
        headers['X-Forwarded-For'] = '127.0.0.1';
    }
    // Any extra headers, JSON: {"Header-Name": "value"}
    if (process.env.REMNAWAVE_HEADERS) {
        try {
            Object.assign(headers, JSON.parse(process.env.REMNAWAVE_HEADERS));
        } catch {
            throw new Error('REMNAWAVE_HEADERS must be JSON, e.g. {"X-Custom": "value"}');
        }
    }
    if (process.env.CF_ACCESS_CLIENT_ID) headers['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
    const cfSecret = secret('CF_ACCESS_CLIENT_SECRET');
    if (cfSecret) headers['CF-Access-Client-Secret'] = cfSecret;

    // Safe by default: write tools appear only with REMNAWAVE_READONLY=false.
    const readonly = (process.env.REMNAWAVE_READONLY || 'true').toLowerCase() !== 'false';
    // `||` instead of `??`: Claude extensions pass empty strings for fields left blank.
    let privacy = (process.env.REMNAWAVE_PRIVACY || 'strict').toLowerCase();
    if ((process.env.REMNAWAVE_SHOW_SECRETS ?? '').toLowerCase() === 'true') privacy = 'off';
    if (!['strict', 'basic', 'off'].includes(privacy))
        throw new Error('REMNAWAVE_PRIVACY must be strict, basic or off');
    const showSecrets = privacy === 'off';
    const include = csv(process.env.REMNAWAVE_TOOLS_INCLUDE);

    return {
        // Contract routes already start with /api — strip it if the user added it.
        baseUrl: baseUrl.replace(/\/+$/, '').replace(/\/api$/, ''),
        headers,
        readonly,
        privacy: privacy as Config['privacy'],
        privacySalt: secret('REMNAWAVE_PRIVACY_SALT'),
        showSecrets,
        exclude: new Set(csv(process.env.REMNAWAVE_TOOLS_EXCLUDE)),
        include: include.length ? new Set(include) : null,
        maxResponseChars: num(process.env.REMNAWAVE_MAX_RESPONSE_CHARS, 60000),
        maxResponseBytes: Math.max(1, Math.floor(num(process.env.REMNAWAVE_MAX_RESPONSE_BYTES, 5 * 1024 * 1024))),
        compact: (process.env.REMNAWAVE_COMPACT || 'true').toLowerCase() !== 'false',
        maxPageSize: num(process.env.REMNAWAVE_MAX_PAGE_SIZE, 200),
        cooldown: {
            geocheck: num(process.env.REMNAWAVE_GEOCHECK_COOLDOWN_MIN, 30),
            connections: num(process.env.REMNAWAVE_CONNECTIONS_COOLDOWN_MIN, 2),
        },
        timeoutMs: num(process.env.REMNAWAVE_TIMEOUT_MS, 30000),
    };
}
