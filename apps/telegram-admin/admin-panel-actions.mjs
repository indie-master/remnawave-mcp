import { createHash } from 'node:crypto';
import { GetUsersCommand, GetNodesCommand, GetNodeCommand, UpdateNodeCommand, GetUserHwidDevicesCommand, DeleteUserHwidDeviceCommand, RevokeUserSubscriptionCommand, ConnectionsByUserCommand, ConnectionsByUserResultCommand } from '@remnawave/backend-contract';

export const directoryPageSize = 8;
export const nodeUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const positiveId = value => /^[1-9]\d{0,15}$/.test(String(value)) && Number.isSafeInteger(Number(value));
const count = value => Number.isSafeInteger(value) && value >= 0;
const unavailable = () => { throw new Error('ADMIN_UNAVAILABLE'); };
const parsedResponse = (command, value) => {
    const result = command.ResponseSchema.safeParse({ response: value });
    return result.success ? result.data.response : unavailable();
};

export function nodeChange(uuid, field, value) {
    if (!nodeUuidPattern.test(uuid) || !['name', 'note'].includes(field) || (typeof value !== 'string' && !(field === 'note' && value === null)) || /[\u0000-\u001f\u007f]/.test(value ?? '')) throw new Error('ADMIN_INVALID_CHANGE');
    const result = UpdateNodeCommand.RequestBodySchema.safeParse({ uuid, [field]: typeof value === 'string' ? value.trim() : value });
    if (!result.success) throw new Error('ADMIN_INVALID_CHANGE');
    return result.data;
}

export function createPanelActions({ read, write }) {
    function userId(id) {
        if (!positiveId(id)) throw new Error('ADMIN_INVALID_REFERENCE');
        return Number(id);
    }
    function nodeId(uuid) {
        if (!nodeUuidPattern.test(uuid)) throw new Error('ADMIN_INVALID_REFERENCE');
        return uuid;
    }
    function nodeView(node) {
        if (!node || !nodeUuidPattern.test(node.uuid) || typeof node.name !== 'string' || ![node.isConnected, node.isDisabled, node.isConnecting].every(flag => typeof flag === 'boolean')) return unavailable();
        return { uuid: node.uuid, name: node.name.slice(0, 60), note: typeof node.note === 'string' ? node.note.slice(0, 255) : null,
            state: node.isDisabled ? 'отключена' : node.isConnected ? 'онлайн' : node.isConnecting ? 'подключается' : 'офлайн',
            online: count(node.usersOnline) ? node.usersOnline : null, country: /^[A-Z]{2}$/.test(node.countryCode) ? node.countryCode : null,
            trafficUsed: count(node.trafficUsedBytes) ? node.trafficUsedBytes : null, trafficLimit: count(node.trafficLimitBytes) ? node.trafficLimitBytes : null,
            updatedAt: typeof node.updatedAt === 'string' ? node.updatedAt : null };
    }
    return {
        async users(page) {
            if (!Number.isSafeInteger(page) || page < 0 || page > Math.floor(Number.MAX_SAFE_INTEGER / directoryPageSize)) throw new Error('ADMIN_INVALID_REFERENCE');
            const start = page * directoryPageSize;
            const query = { start, size: directoryPageSize, sorting: [{ id: 'id', desc: false }] };
            GetUsersCommand.RequestQuerySchema.parse(Object.fromEntries(Object.entries(query).map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value)])));
            const value = await read('GET', GetUsersCommand.url, query);
            if (!count(value?.total) || !Array.isArray(value.users) || value.users.length !== Math.min(directoryPageSize, Math.max(0, value.total - start))) return unavailable();
            const users = value.users.map(user => {
                if (!Number.isSafeInteger(user?.id) || user.id <= 0 || typeof user.username !== 'string' || !/^[A-Za-z0-9_-]{3,36}$/.test(user.username) || !['ACTIVE', 'DISABLED', 'LIMITED', 'EXPIRED'].includes(user.status)) return unavailable();
                return { id: user.id, username: user.username, status: user.status };
            });
            if (new Set(users.map(user => user.id)).size !== users.length) return unavailable();
            return { total: value.total, users };
        },
        async nodes() {
            const value = await read('GET', GetNodesCommand.url);
            if (!Array.isArray(value) || value.length > 1000) return unavailable();
            const nodes = value.map(nodeView);
            if (new Set(nodes.map(node => node.uuid)).size !== nodes.length) return unavailable();
            return nodes;
        },
        async node(uuid) {
            const value = nodeView(await read('GET', GetNodeCommand.url(nodeId(uuid))));
            return value.uuid === uuid ? value : unavailable();
        },
        async updateNode(uuid, field, value) {
            const result = await write('PATCH', UpdateNodeCommand.url, undefined, nodeChange(uuid, field, value));
            if (result?.uuid !== uuid || result[field] !== value) return unavailable();
        },
        async devices(id) {
            const target = userId(id);
            const result = parsedResponse(GetUserHwidDevicesCommand, await read('GET', GetUserHwidDevicesCommand.url(target)));
            if (result.total !== result.devices.length || result.devices.some(device => device.userId !== target || !device.hwid)) return unavailable();
            const devices = result.devices.map(device => ({
                selector: createHash('sha256').update(JSON.stringify([target, device.hwid, device.createdAt])).digest('base64url').slice(0, 22),
                hwid: device.hwid, label: [device.platform, device.deviceModel, device.osVersion].filter(Boolean).join(' · ').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 90) || 'Устройство', createdAt: device.createdAt.toISOString(),
            }));
            if (new Set(devices.map(device => device.selector)).size !== devices.length) return unavailable();
            return devices;
        },
        async deleteDevice(id, hwid) {
            const body = DeleteUserHwidDeviceCommand.RequestBodySchema.parse({ userId: userId(id), hwid });
            const result = parsedResponse(DeleteUserHwidDeviceCommand, await write('POST', DeleteUserHwidDeviceCommand.url, undefined, body));
            if (result.total !== result.devices.length || result.devices.some(device => device.userId !== body.userId || device.hwid === hwid)) return unavailable();
        },
        async revoke(id, mode, previousShortUuid) {
            if (!['rotate', 'keys'].includes(mode)) throw new Error('ADMIN_INVALID_CHANGE');
            const target = userId(id);
            const body = RevokeUserSubscriptionCommand.RequestBodySchema.parse({ revokeOnlyPasswords: mode === 'keys' });
            const result = await write('POST', RevokeUserSubscriptionCommand.url(target), undefined, body);
            if (result?.id !== target || typeof result.shortUuid !== 'string' || typeof result.subRevokedAt !== 'string' || (result.shortUuid === previousShortUuid) !== (mode === 'keys')) return unavailable();
        },
        async startConnections(id) {
            const result = parsedResponse(ConnectionsByUserCommand, await read('POST', ConnectionsByUserCommand.url(userId(id))));
            return /^[A-Za-z0-9_-]{1,128}$/.test(result.jobId) ? result.jobId : unavailable();
        },
        async connections(id, job) {
            const target = userId(id);
            if (!/^[A-Za-z0-9_-]{1,128}$/.test(job)) throw new Error('ADMIN_INVALID_REFERENCE');
            const result = parsedResponse(ConnectionsByUserResultCommand, await read('GET', ConnectionsByUserResultCommand.url(job)));
            if (result.isFailed) return unavailable();
            if (!result.isCompleted) return { pending: true };
            if (!result.result?.success || result.result.userId !== target) return unavailable();
            return { nodes: result.result.nodes.filter(node => node.ips.length).map(node => ({ name: node.nodeName.slice(0, 60), count: node.ips.length, lastSeen: new Date(node.ips.reduce((latest, item) => Math.max(latest, item.lastSeen.getTime()), 0)).toISOString() })) };
        },
    };
}
