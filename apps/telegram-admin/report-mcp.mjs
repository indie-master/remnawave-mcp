import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { expiryWindows, mcpSafeExpiry } from './panel-service.mjs';

const requireFromProject = createRequire(new URL('../../package.json', import.meta.url));
const { Server } = await import(pathToFileURL(requireFromProject.resolve('@modelcontextprotocol/sdk/server/index.js')));
const { Client } = await import(pathToFileURL(requireFromProject.resolve('@modelcontextprotocol/sdk/client/index.js')));
const { InMemoryTransport } = await import(pathToFileURL(requireFromProject.resolve('@modelcontextprotocol/sdk/inMemory.js')));
const { ListToolsRequestSchema, CallToolRequestSchema } = await import(pathToFileURL(requireFromProject.resolve('@modelcontextprotocol/sdk/types.js')));

export const reportTools = {
    version: 'get_metadata', stats: 'get_stats', nodes: 'get_nodes', expiring: 'expiring_subscriptions',
    users: 'get_user_counts', online: 'get_online_counts', node_details: 'get_node_details',
    hosts: 'get_host_counts', profiles: 'get_profile_counts', internal_squads: 'get_internal_squad_counts', external_squads: 'get_external_squad_counts',
    system: 'get_system_resources', bandwidth: 'get_bandwidth_totals', health: 'get_runtime_health',
};

export function createReportMcp(service) {
    const server = new Server({ name: 'panel_reports', version: '1.0.0' }, {
        capabilities: { tools: {} },
        instructions: 'Only read-only panel reports. Never send notifications or change subscriptions. User identifiers are local references, not credentials. A partial report is not a complete user list. Use observedAt; never replace errors with zero counts.',
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Object.entries(reportTools).map(([action, name]) => ({
        name, description: action === 'expiring' ? 'Active subscriptions expiring within the next 1, 3, 7, 14 or 30 days; usernames pseudonymized.' : `Read-only panel ${action} report.`,
        inputSchema: { type: 'object', properties: action === 'expiring' ? { days: { type: 'integer', enum: expiryWindows, default: 3 } } : {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false },
    })) }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
        try {
            const action = Object.keys(reportTools).find(key => reportTools[key] === request.params.name);
            const args = request.params.arguments ?? {};
            if (!action || Object.keys(args).some(key => action !== 'expiring' || key !== 'days')) throw new Error('REQUEST_BLOCKED');
            if (action === 'expiring' && args.days !== undefined && !expiryWindows.includes(args.days)) throw new Error('REQUEST_BLOCKED');
            const data = action === 'expiring' ? mcpSafeExpiry(await service.expiring(args)) : await service[action]();
            return { content: [{ type: 'text', text: JSON.stringify(data) }] };
        } catch {
            return { isError: true, content: [{ type: 'text', text: 'REPORT_UNAVAILABLE: verify read scopes, token validity and data format; no changes were made.' }] };
        }
    });
    return server;
}

export async function connectReportMcp(service) {
    const server = createReportMcp(service);
    const client = new Client({ name: 'telegram-report-client', version: '1' });
    const pair = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(pair[0]), client.connect(pair[1])]);
    return {
        async read(action, days = 3) {
            if (!Object.hasOwn(reportTools, action)) throw new Error('UNKNOWN_REPORT');
            const result = await client.callTool({ name: reportTools[action], arguments: action === 'expiring' ? { days } : {} });
            if (result.isError) throw new Error('REPORT_UNAVAILABLE');
            return JSON.parse(result.content[0].text);
        },
        close: () => Promise.allSettled([client.close(), server.close()]),
    };
}
