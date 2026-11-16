const count = value => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_PANEL_RESPONSE');
    return value;
};
const amount = value => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('INVALID_PANEL_RESPONSE');
    return value;
};
const traffic = value => {
    if (typeof value !== 'string' || !/^\d{1,40}(?:\.\d{1,10})?(?: (?:B|[kKMGTPEZY]i?B))?$/.test(value)) throw new Error('INVALID_PANEL_RESPONSE');
    return value;
};
const listCount = (data, key) => {
    if (!Array.isArray(data?.[key]) || count(data.total) !== data[key].length) throw new Error('INVALID_PANEL_RESPONSE');
    return data.total;
};

export function createExtraReports({ read, now }) {
    const observed = data => ({ ...data, observedAt: new Date(now()).toISOString() });
    const stats = handler => read(async client => handler(await client.request('GET', '/api/system/stats', { tz: 'UTC' })));
    return {
        users: () => stats(data => {
            const totalUsers = count(data?.users?.totalUsers);
            const statuses = {};
            for (const status of ['ACTIVE', 'DISABLED', 'LIMITED', 'EXPIRED']) statuses[status] = count(data?.users?.statusCounts?.[status]);
            if (Object.values(statuses).reduce((total, value) => total + value, 0) !== totalUsers) throw new Error('INVALID_PANEL_RESPONSE');
            return observed({ totalUsers, statuses });
        }),
        online: () => stats(data => {
            const totalUsers = count(data?.users?.totalUsers);
            const metrics = {};
            for (const key of ['onlineNow', 'lastDay', 'lastWeek', 'neverOnline']) {
                metrics[key] = count(data?.onlineStats?.[key]);
                if (metrics[key] > totalUsers) throw new Error('INVALID_PANEL_RESPONSE');
            }
            return observed({ totalUsers, ...metrics });
        }),
        system: () => stats(data => {
            const report = { cores: count(data?.cpu?.cores), uptimeSeconds: amount(data?.uptime), memoryTotal: amount(data?.memory?.total), memoryUsed: amount(data?.memory?.used), memoryFree: amount(data?.memory?.free) };
            if (report.cores < 1 || report.memoryUsed > report.memoryTotal || report.memoryFree > report.memoryTotal) throw new Error('INVALID_PANEL_RESPONSE');
            return observed(report);
        }),
        node_details: () => read(async client => {
            const data = await client.request('GET', '/api/nodes/');
            if (!Array.isArray(data) || data.length > 1000) throw new Error('INVALID_PANEL_RESPONSE');
            const nodes = data.map((node, index) => {
                if (!node || ![node.isConnected, node.isDisabled, node.isConnecting].every(value => typeof value === 'boolean')) throw new Error('INVALID_PANEL_RESPONSE');
                const state = node.isDisabled ? 'disabled' : node.isConnected ? 'online' : node.isConnecting ? 'connecting' : 'offline';
                return { reference: index + 1, state, usersOnline: node.usersOnline === undefined || node.usersOnline === null ? null : count(node.usersOnline) };
            });
            return observed({ total: nodes.length, nodes });
        }),
        hosts: () => read(async client => {
            const data = await client.request('GET', '/api/hosts/');
            if (!Array.isArray(data) || data.some(host => typeof host?.isDisabled !== 'boolean')) throw new Error('INVALID_PANEL_RESPONSE');
            return observed({ total: data.length, enabled: data.filter(host => !host.isDisabled).length, disabled: data.filter(host => host.isDisabled).length });
        }),
        profiles: () => read(async client => observed({ total: listCount(await client.request('GET', '/api/config-profiles/'), 'configProfiles') })),
        internal_squads: () => read(async client => observed({ total: listCount(await client.request('GET', '/api/internal-squads/'), 'internalSquads') })),
        external_squads: () => read(async client => observed({ total: listCount(await client.request('GET', '/api/external-squads/'), 'externalSquads') })),
        bandwidth: () => read(async client => {
            const data = await client.request('GET', '/api/system/stats/bandwidth', { tz: 'Europe/Moscow' });
            const periods = {};
            for (const key of ['bandwidthLastTwoDays', 'bandwidthLastSevenDays', 'bandwidthLast30Days', 'bandwidthCalendarMonth', 'bandwidthCurrentYear']) periods[key] = { current: traffic(data?.[key]?.current), previous: traffic(data?.[key]?.previous) };
            return observed({ periods });
        }),
        health: () => read(async client => {
            const data = await client.request('GET', '/api/system/health');
            if (!Array.isArray(data?.runtimeMetrics) || data.runtimeMetrics.length === 0) throw new Error('INVALID_PANEL_RESPONSE');
            const processes = data.runtimeMetrics.map(item => ({ uptimeSeconds: amount(item?.uptime), rssBytes: amount(item?.rss), eventLoopDelayMs: amount(item?.eventLoopDelayMs) }));
            return observed({ processes });
        }),
    };
}
