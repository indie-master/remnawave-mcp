export function createSupportAdministration({ store }) {
    return async (incoming, outgoing) => {
        const thread = incoming.url?.match(/^\/support\/([a-f0-9]{24})$/);
        if (!thread && !['/support-message', '/support-close', '/support-reply'].includes(incoming.url)) return false;
        const send = (status, value) => outgoing.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
        try {
            if (thread && incoming.method === 'GET') { send(200, store.supportThread(thread[1])); return true; }
            if (incoming.method !== 'POST' || thread || incoming.headers['content-type'] !== 'application/json') throw new Error();
            const chunks = []; let bytes = 0;
            for await (const chunk of incoming) { bytes += chunk.length; if (bytes > 4096) throw new Error(); chunks.push(chunk); }
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
            const keys = Object.keys(value).sort().join(',');
            if (incoming.url === '/support-message') {
                if (keys !== 'id,key,text') throw new Error();
                send(200, store.supportMessage(value.id, value.key, value.text));
            } else if (incoming.url === '/support-close') {
                if (keys !== 'id,version') throw new Error();
                send(200, store.closeSupport(value.id, value.version));
            } else {
                if (keys !== 'id,text' || !/^[a-f0-9]{24}$/.test(value.id ?? '')) throw new Error();
                send(200, store.replySupport(value.id, value.text));
            }
        } catch { send(400, { code: 'SUPPORT_REQUEST_REJECTED' }); }
        return true;
    };
}
