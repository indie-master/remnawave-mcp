import { request } from 'node:http';
import { isAbsolute } from 'node:path';
import { validateIntent } from './intent.mjs';
import { normalizeQuestion } from './intent-store.mjs';

export const classifierSocket = '/bridge/classifier.sock';

export function createClassifierClient({ socketPath = classifierSocket, signal } = {}) {
    if (!isAbsolute(socketPath) || socketPath.length > 200) throw new Error('INVALID_AI_CONFIGURATION');
    return text => {
        normalizeQuestion(text);
        if (signal?.aborted) return Promise.reject(new Error('AI_UNAVAILABLE'));
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({ question: text });
            const connection = request({ socketPath, path: '/classify', method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, signal }, response => {
                const chunks = [];
                let size = 0;
                response.on('data', chunk => {
                    size += chunk.length;
                    if (size > 4096) connection.destroy(new Error('AI_UNAVAILABLE'));
                    else chunks.push(chunk);
                });
                response.once('error', () => reject(new Error('AI_UNAVAILABLE')));
                response.once('end', () => {
                    try {
                        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        if (response.statusCode !== 200) {
                            const code = ['AI_DAILY_LIMIT', 'AI_RATE_LIMIT', 'AI_BUSY', 'AI_PAUSED'].includes(value?.code) ? value.code : 'AI_UNAVAILABLE';
                            reject(new Error(code)); return;
                        }
                        resolve(validateIntent(value));
                    } catch { reject(new Error('AI_UNAVAILABLE')); }
                });
            });
            const timer = setTimeout(() => connection.destroy(new Error('AI_UNAVAILABLE')), 55000);
            connection.once('close', () => clearTimeout(timer));
            connection.once('error', () => reject(new Error('AI_UNAVAILABLE')));
            connection.end(body);
        });
    };
}
