import { request } from 'node:http';
export function createCustomerClient({ requestImpl = request, signal } = {}) {
    return (path, value) => new Promise((resolve, reject) => {
        if (!['/ready', '/link', '/account', '/history', '/question', '/deliveries/claim', '/deliveries/settle'].includes(path) || (path === '/ready') !== (value === undefined)) { reject(new Error('CUSTOMER_UNAVAILABLE')); return; }
        const call = requestImpl({ socketPath: '/customer-bridge/customer.sock', method: value === undefined ? 'GET' : 'POST', path, headers: { 'Content-Type': 'application/json' }, timeout: 20000, signal }, incoming => {
            const chunks = []; let bytes = 0;
            incoming.on('data', chunk => { bytes += chunk.length; if (bytes > 32768) incoming.destroy(); else chunks.push(chunk); });
            incoming.on('error', () => reject(new Error('CUSTOMER_UNAVAILABLE')));
            incoming.on('end', () => { try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (incoming.statusCode !== 200) throw new Error(['CUSTOMER_NOT_LINKED', 'CUSTOMER_LINK_REJECTED', 'CUSTOMER_RATE_LIMIT', 'INVALID_MESSAGE'].includes(body.code) ? body.code : 'CUSTOMER_UNAVAILABLE'); resolve(body); } catch (error) { reject(new Error(['CUSTOMER_NOT_LINKED', 'CUSTOMER_LINK_REJECTED', 'CUSTOMER_RATE_LIMIT', 'INVALID_MESSAGE'].includes(error?.message) ? error.message : 'CUSTOMER_UNAVAILABLE')); } });
        });
        call.on('error', () => reject(new Error('CUSTOMER_UNAVAILABLE'))); call.on('timeout', () => call.destroy());
        call.end(value === undefined ? undefined : JSON.stringify(value));
    });
}
