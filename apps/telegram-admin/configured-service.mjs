import { readFileSync, statSync } from 'node:fs';
import { RemnawaveClient } from '../../dist/client.js';
import { createPanelService } from './panel-service.mjs';

export function createConfiguredService({ baseUrl, tokenFile, usersEnabled = false, signal }) {
    let address;
    try { address = new URL(baseUrl); }
    catch { throw new Error('INVALID_LOCAL_CONFIGURATION'); }
    if (address.protocol !== 'https:' || address.username || address.password || address.search || address.hash || address.pathname !== '/')
        throw new Error('INVALID_LOCAL_CONFIGURATION');
    const service = createPanelService({
        usersEnabled,
        clientFactory: () => {
            if (signal?.aborted) throw new Error('STOP_REQUESTED');
            if (statSync(tokenFile).size > 4096) throw new Error('INVALID_LOCAL_CREDENTIAL');
            const token = readFileSync(tokenFile, 'utf8').trim();
            if (!token || /\s/.test(token)) throw new Error('INVALID_LOCAL_CREDENTIAL');
            const client = new RemnawaveClient({ baseUrl: address.origin, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeoutMs: 15000, maxResponseBytes: 1024 * 1024 });
            return {
                request: async (...args) => {
                    if (signal?.aborted) throw new Error('STOP_REQUESTED');
                    return client.request(...args);
                },
            };
        },
    });
    return { ...service, bypassProxyHost: address.hostname };
}
