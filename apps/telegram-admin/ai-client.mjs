import { request } from 'node:http';
import { isAbsolute } from 'node:path';
import { validateIntent } from './intent.mjs';
import { normalizeQuestion } from './intent-store.mjs';

export const classifierSocket = '/bridge/classifier.sock';

export function createClassifierClient({ socketPath = classifierSocket, signal } = {}) {
    if (!isAbsolute(socketPath) || socketPath.length > 200) throw new Error('INVALID_AI_CONFIGURATION');
    const send = (text, mode = 'classify') => {
        const health = mode !== 'classify';
        const unavailable = health ? 'AI_BRIDGE_UNAVAILABLE' : 'AI_UNAVAILABLE';
        if (signal?.aborted) return Promise.reject(new Error(unavailable));
        return new Promise((resolve, reject) => {
            const body = health ? undefined : JSON.stringify({ question: text });
            const connection = request({ socketPath, path: `/${mode}`, method: health ? 'GET' : 'POST', agent: false, headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}, signal }, response => {
                const chunks = [];
                let size = 0;
                response.on('data', chunk => {
                    size += chunk.length;
                    if (size > 4096) connection.destroy(new Error(unavailable));
                    else chunks.push(chunk);
                });
                response.once('error', () => reject(new Error(unavailable)));
                response.once('end', () => {
                    try {
                        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        if (response.statusCode !== 200) {
                            const code = ['AI_DAILY_LIMIT', 'AI_RATE_LIMIT', 'AI_BUSY', 'AI_PAUSED'].includes(value?.code) ? value.code : unavailable;
                            reject(new Error(code)); return;
                        }
                        if (health) {
                            if (mode === 'usage') {
                                if (Object.keys(value).sort().join(',') !== 'cacheEntries,day,limit,remaining,used' || !/^\d{4}-\d{2}-\d{2}$/.test(value.day) || ['used', 'limit', 'remaining'].some(key => !Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 100) || !Number.isSafeInteger(value.cacheEntries)) throw new Error(unavailable);
                                resolve(value); return;
                            }
                            if (Object.keys(value).join(',') !== 'ready' || value.ready !== true) throw new Error(unavailable);
                            resolve();
                        } else resolve(validateIntent(value));
                    } catch { reject(new Error(unavailable)); }
                });
            });
            const timer = setTimeout(() => connection.destroy(new Error(unavailable)), health ? 3000 : 55000);
            connection.once('close', () => clearTimeout(timer));
            connection.once('error', () => reject(new Error(unavailable)));
            connection.end(body);
        });
    };
    const classify = text => { normalizeQuestion(text); return send(text); };
    classify.checkReady = () => send(undefined, 'health');
    classify.usage = () => send(undefined, 'usage');
    return classify;
}
