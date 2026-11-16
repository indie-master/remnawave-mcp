export function createCustomerGateway({ store, username, panelRead, miniAppUrl }) {
    if (!store.customer.enabled || !/^[A-Za-z0-9_]{5,32}$/.test(username)) throw new Error('CUSTOMER_DISABLED');
    return async (incoming, outgoing) => {
        const send = (status, value) => { if (!outgoing.destroyed) outgoing.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value)); };
        try {
            if (incoming.method === 'GET' && incoming.url === '/ready') { send(200, { ready: true, botUsername: username, ...(miniAppUrl ? { miniAppUrl } : {}) }); return; }
            if (incoming.method !== 'POST' || incoming.headers['content-type'] !== 'application/json' || !['/identity', '/bootstrap', '/link', '/account', '/history', '/question', '/deliveries/claim', '/deliveries/settle'].includes(incoming.url)) throw new Error('CUSTOMER_REQUEST_REJECTED');
            const chunks = []; let bytes = 0;
            for await (const chunk of incoming) { bytes += chunk.length; if (bytes > 4096) throw new Error('CUSTOMER_REQUEST_REJECTED'); chunks.push(chunk); }
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('CUSTOMER_REQUEST_REJECTED');
            const keys = Object.keys(body).sort().join(',');
            if (incoming.url === '/identity' && keys === 'botId,username' && body.username?.toLowerCase() === username.toLowerCase()) { send(200, store.customer.registerBot(username, body.botId)); return; }
            if (incoming.url === '/bootstrap' && keys === 'firstName,lastName,telegramId') { send(200, store.customer.ensure(body)); return; }
            if (incoming.url === '/link' && keys === 'code,telegramId') { send(200, store.customer.link(body.telegramId, body.code)); return; }
            if (incoming.url === '/history' && keys === 'telegramId') { send(200, { history: store.customer.history(body.telegramId).slice(-6) }); return; }
            if (incoming.url === '/question' && keys === 'key,telegramId,text') { send(200, store.customer.question(body.telegramId, body.key, body.text)); return; }
            if (incoming.url === '/account' && keys === 'telegramId') {
                const account = store.customer.account(body.telegramId);
                let subscription;
                try { if (account.panelId) subscription = await panelRead?.(account.panelId); } catch {}
                send(200, { balances: account.balances, profileName: account.profileName, panelLinked: !!account.panelId, subscription: subscription ?? null }); return;
            }
            if (incoming.url === '/deliveries/claim' && keys === '') { send(200, store.customer.claim()); return; }
            if (incoming.url === '/deliveries/settle' && keys === 'id,lease,outcome') { send(200, store.customer.settle(body.id, body.lease, body.outcome)); return; }
            throw new Error('CUSTOMER_REQUEST_REJECTED');
        } catch (error) {
            const code = ['CUSTOMER_NOT_LINKED', 'CUSTOMER_LINK_REJECTED', 'CUSTOMER_RATE_LIMIT', 'INVALID_MESSAGE'].includes(error?.message) ? error.message : 'CUSTOMER_REQUEST_REJECTED';
            send(400, { code });
        }
    };
}
