export function createBillingAdministration({ store, enabled = false }) {
    return async (incoming, outgoing) => {
        const path = incoming.url;
        if (!['/recovery', '/billing-history', '/renewal-reconcile'].includes(path) && !/^\/recovery\/[a-f0-9]{24}$/.test(path)) return false;
        const send = (status, value) => outgoing.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
        try {
            if (!enabled || store.reconciliationEnabled !== true) throw new Error();
            if (incoming.method === 'GET' && path === '/recovery') { send(200, { cases: store.recoveryCases() }); return true; }
            if (incoming.method === 'GET' && path === '/billing-history') { send(200, { entries: store.billingHistory() }); return true; }
            if (incoming.method === 'GET' && path.startsWith('/recovery/')) { send(200, store.recoveryCase(path.slice(10))); return true; }
            if (incoming.method !== 'POST' || path !== '/renewal-reconcile' || incoming.headers['content-type'] !== 'application/json') throw new Error();
            const chunks = []; let size = 0;
            for await (const chunk of incoming) { size += chunk.length; if (size > 4096) throw new Error(); chunks.push(chunk); }
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'id,note,outcome,proposal,state') throw new Error();
            send(200, store.reconcileRenewal(value.id, value));
        } catch { incoming.resume(); send(400, { code: 'RECONCILIATION_REJECTED' }); }
        return true;
    };
}
