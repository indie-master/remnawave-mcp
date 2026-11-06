import { readFileSync, statSync } from 'node:fs';
import { redactSupport } from './store.mjs';

export function createReferenceSearch({ store, allowedHosts = ['docs.rw'], dailyLimit = 0, fetchImpl = fetch, readToken = () => {
    const path = '/run/secrets/search_api_token';
    if (statSync(path).size > 4096) throw new Error('SEARCH_UNAVAILABLE');
    return readFileSync(path, 'utf8').trim();
} }) {
    if (!Number.isInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > 10 || !Array.isArray(allowedHosts) || !allowedHosts.length || allowedHosts.length > 5 || allowedHosts.some(host => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host))) throw new Error('INVALID_SEARCH_CONFIGURATION');
    return async question => {
        const match = question.match(/^(?:найди|найти)\s+инструкци[юи]\s+(?:для|по)\s+(happ|v2rayn|v2rayng|hiddify|streisand|shadowrocket)(?:\s+(windows|android|ios|macos|linux))?$/i);
        if (!match) throw new Error('SEARCH_QUERY_REJECTED');
        const key = `${match[1].toLowerCase()}:${match[2]?.toLowerCase() ?? 'all'}`;
        const cached = store.searchCache(key);
        if (cached) return cached;
        if (!dailyLimit) throw new Error('SEARCH_DISABLED');
        const token = readToken(); if (!token || /\s/.test(token)) throw new Error('SEARCH_UNAVAILABLE');
        store.reserveSearch(dailyLimit);
        const endpoint = new URL('https://api.search.brave.com/res/v1/web/search');
        endpoint.searchParams.set('q', `${match[1]} ${match[2] ?? ''} connection troubleshooting (${allowedHosts.map(host => 'site:' + host).join(' OR ')})`);
        endpoint.searchParams.set('count', '5');
        const response = await fetchImpl(endpoint, { headers: { 'X-Subscription-Token': token, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000) });
        if (!response.ok || Number(response.headers.get('content-length')) > 131072) { await response.body?.cancel(); throw new Error('SEARCH_UNAVAILABLE'); }
        const chunks = []; let bytes = 0;
        for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 131072) throw new Error('SEARCH_UNAVAILABLE'); chunks.push(chunk); }
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const results = [];
        for (const item of data.web?.results ?? []) {
            try {
                const url = new URL(item.url);
                if (url.protocol !== 'https:' || !allowedHosts.includes(url.hostname) || url.username || url.password || url.href.length > 2048) continue;
                if (typeof item.title !== 'string' || typeof item.description !== 'string') continue;
                results.push({ title: redactSupport(item.title.replace(/<[^>]*>/g, '')).slice(0, 100), url: url.href, text: redactSupport(item.description.replace(/<[^>]*>/g, '')).slice(0, 350) });
            } catch {}
            if (results.length >= 3) break;
        }
        if (!results.length) throw new Error('SEARCH_UNAVAILABLE');
        store.putSearchCache(key, results);
        return results;
    };
}
