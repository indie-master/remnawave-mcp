import type { Config } from './config.js';

export class ApiError extends Error {
    constructor(
        public status: number,
        message: string,
    ) {
        super(message);
    }
}

export class RemnawaveClient {
    constructor(private cfg: Config) {}

    async request(method: string, path: string, query?: Record<string, unknown>, body?: unknown): Promise<unknown> {
        // Last line of defence: a "." or ".." segment (also percent-encoded) would move the request to another endpoint.
        if (path.split(/[?#]/)[0].split('/').some((s) => /^(\.|%2e){1,2}$/i.test(s)))
            throw new Error(`Refusing request path with "." or ".." segments: ${path.split(/[?#]/)[0]}`);
        const url = new URL(this.cfg.baseUrl + path);
        for (const [k, v] of Object.entries(query ?? {})) {
            if (v === undefined || v === null) continue;
            // Contract query schemas JSON-parse arrays/objects (TanStack filters, sorting).
            url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        }

        const res = await fetch(url, {
            method,
            redirect: 'error',
            headers: this.cfg.headers,
            body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
            signal: this.cfg.timeoutMs > 0 ? AbortSignal.timeout(this.cfg.timeoutMs) : undefined,
        });

        if (!res.ok) {
            await res.body?.cancel().catch(() => undefined);
            throw new ApiError(res.status, `Remnawave API ${res.status}: request failed`);
        }

        const maxBytes = this.cfg.maxResponseBytes ?? 5 * 1024 * 1024;
        if (Number(res.headers.get('content-length')) > maxBytes) {
            await res.body?.cancel().catch(() => undefined);
            throw new Error(`Remnawave API response exceeds ${maxBytes} bytes`);
        }
        const chunks: Uint8Array[] = [];
        let bytesRead = 0;
        const reader = res.body?.getReader();
        if (reader) {
            try {
                while (true) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    bytesRead += chunk.value.byteLength;
                    if (bytesRead > maxBytes) {
                        await reader.cancel().catch(() => undefined);
                        throw new Error(`Remnawave API response exceeds ${maxBytes} bytes`);
                    }
                    chunks.push(chunk.value);
                }
            } finally {
                reader.releaseLock();
            }
        }
        const text = Buffer.concat(chunks).toString('utf8');
        let data: unknown = text;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            /* keep text */
        }

        // All Remnawave responses are wrapped in { response: ... }
        if (data && typeof data === 'object' && 'response' in data) return (data as { response: unknown }).response;
        return data;
    }
}
