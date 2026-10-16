import { request } from 'node:http';
export function createMediaAnalyzer({ applications = 'happ', requestImpl = request } = {}) {
    if (!/^[a-z0-9]+(?:,[a-z0-9]+){0,9}$/.test(applications)) throw new Error('INVALID_MEDIA_CONFIGURATION');
    return (bytes, type) => new Promise((resolve, reject) => {
        if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > 10485760 || !['image/png', 'image/jpeg', 'video/mp4'].includes(type)) { reject(new Error('MEDIA_REJECTED')); return; }
        const call = requestImpl({ socketPath: '/media-bridge/analyze.sock', method: 'POST', path: '/analyze', headers: { 'Content-Type': type, 'Content-Length': bytes.length, 'X-Applications': applications }, timeout: 35000 }, response => {
            let data = ''; response.on('data', chunk => { data += chunk; if (data.length > 8192) response.destroy(); });
            response.on('error', () => reject(new Error('MEDIA_UNAVAILABLE')));
            response.on('end', () => {
                try { const value = JSON.parse(data); if (response.statusCode !== 200 || typeof value.relevant !== 'boolean' || typeof value.text !== 'string' || value.text.length > 500) throw new Error(); resolve(value); }
                catch { reject(new Error('MEDIA_UNAVAILABLE')); }
            });
        }); call.on('timeout', () => call.destroy()); call.on('error', () => reject(new Error('MEDIA_UNAVAILABLE'))); call.end(bytes);
    });
}
