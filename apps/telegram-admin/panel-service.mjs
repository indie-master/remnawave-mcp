function count(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_PANEL_RESPONSE');
    return value;
}

export const expiryWindows = [1, 3, 7, 14, 30];

export function createPanelService({ clientFactory, usersEnabled = false, now = Date.now, pageSize = 100, maxPages = 10 }) {
    if (typeof clientFactory !== 'function' || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10)
        throw new Error('INVALID_SERVICE_CONFIGURATION');
    let busy = false;
    const names = new Map();
    async function read(action) {
        if (busy) throw new Error('PANEL_BUSY');
        busy = true;
        try { return await action(clientFactory()); }
        finally { busy = false; }
    }
    return {
        ownerName: id => names.get(id),
        version: () => read(async client => {
            const data = await client.request('GET', '/api/system/metadata');
            if (typeof data?.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(data.version)) throw new Error('INVALID_PANEL_RESPONSE');
            return { panelVersion: data.version, observedAt: new Date(now()).toISOString() };
        }),
        stats: () => read(async client => {
            const data = await client.request('GET', '/api/system/stats', { tz: 'UTC' });
            const totalUsers = count(data?.users?.totalUsers);
            const usersOnline = count(data?.onlineStats?.onlineNow);
            if (usersOnline > totalUsers) throw new Error('INVALID_PANEL_RESPONSE');
            return { totalUsers, usersOnline, observedAt: new Date(now()).toISOString() };
        }),
        nodes: () => read(async client => {
            const data = await client.request('GET', '/api/nodes/');
            if (!Array.isArray(data)) throw new Error('INVALID_PANEL_RESPONSE');
            const totals = { nodesTotal: data.length, nodesOnline: 0, nodesOffline: 0, nodesDisabled: 0, nodesConnecting: 0 };
            for (const node of data) {
                if (!node || typeof node.isConnected !== 'boolean' || (node.isDisabled !== undefined && typeof node.isDisabled !== 'boolean') || (node.isConnecting !== undefined && typeof node.isConnecting !== 'boolean'))
                    throw new Error('INVALID_PANEL_RESPONSE');
                if (node.isDisabled) totals.nodesDisabled++;
                else if (node.isConnected) totals.nodesOnline++;
                else if (node.isConnecting) totals.nodesConnecting++;
                else totals.nodesOffline++;
            }
            return { ...totals, observedAt: new Date(now()).toISOString() };
        }),
        expiring: async ({ days = 3 } = {}) => {
            if (!usersEnabled) throw new Error('USERS_READ_NOT_ENABLED');
            if (!expiryWindows.includes(days)) throw new Error('INVALID_EXPIRY_WINDOW');
            return read(async client => {
                const startTime = now();
                const endTime = startTime + days * 86400000;
                const users = [];
                const seen = new Set();
                let total = null;
                let scanned = 0;
                let complete = false;
                for (let page = 0; page < maxPages; page++) {
                    const data = await client.request('GET', '/api/users/', { start: page * pageSize, size: pageSize, sorting: [{ id: 'expireAt', desc: false }] });
                    if (!Array.isArray(data?.users) || data.users.length > pageSize) throw new Error('INVALID_PANEL_RESPONSE');
                    const nextTotal = count(data.total);
                    if (total !== null && nextTotal !== total) throw new Error('USER_LIST_CHANGED_RETRY');
                    total = nextTotal;
                    for (const user of data.users) {
                        if (!user || !Number.isSafeInteger(user.id) || user.id < 1 || seen.has(user.id)) throw new Error('INVALID_PANEL_RESPONSE');
                        seen.add(user.id);
                        scanned++;
                        if (typeof user.expireAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(user.expireAt)) throw new Error('INVALID_PANEL_RESPONSE');
                        const expiry = Date.parse(user.expireAt);
                        if (!Number.isFinite(expiry)) throw new Error('INVALID_PANEL_RESPONSE');
                        if (user.status !== 'ACTIVE' || expiry < startTime || expiry > endTime) continue;
                        const username = typeof user.username === 'string' ? user.username.slice(0, 80).replace(/[\u0000-\u001f\u007f]/g, '') : `user-${user.id}`;
                        users.push({
                            id: user.id, username, status: 'ACTIVE', expireAt: new Date(expiry).toISOString(),
                            hoursRemaining: Math.max(0, Math.ceil((expiry - startTime) / 3600000)),
                            trafficUsedBytes: user.userTraffic?.usedTrafficBytes === undefined ? null : count(user.userTraffic.usedTrafficBytes),
                            trafficLimitBytes: user.trafficLimitBytes === undefined ? null : count(user.trafficLimitBytes),
                            telegramLinked: Number.isSafeInteger(user.telegramId) && user.telegramId > 0,
                        });
                    }
                    if (scanned > total) throw new Error('INVALID_PANEL_RESPONSE');
                    if (scanned === total) { complete = true; break; }
                    if (data.users.length === 0) throw new Error('USER_LIST_INCOMPLETE');
                }
                users.sort((first, second) => first.expireAt.localeCompare(second.expireAt) || first.id - second.id);
                names.clear();
                for (const user of users) names.set(user.id, user.username);
                return { days, observedAt: new Date(startTime).toISOString(), complete, scanned, total, count: users.length, users };
            });
        },
    };
}

export function mcpSafeExpiry(report) {
    return { ...report, users: report.users.map(user => ({ ...user, username: `client~${user.id}` })) };
}
