import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { editableFields } from './admin-users.mjs';

export function createAdministrationMcp(administration, actorId) {
    const server = new Server({ name: 'panel_admin_proposals', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: 'Only summaries and proposals. No tool confirms or executes panel changes. Ask the human administrator to open the proposal in the sole-admin Telegram chat with заявка PROPOSAL_ID and confirm there. Never claim a proposal has changed a subscription. Do not request, display or infer tokens, passwords or subscription URLs.' });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
        { name: 'get_user_summary', description: 'Fresh minimal user status, no username, email, description, Telegram ID or subscription URL.', inputSchema: { type: 'object', properties: { reference: { type: 'string', maxLength: 36 } }, required: ['reference'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false } },
        { name: 'prepare_user_change', description: 'Create a short-lived proposal. Human confirmation outside MCP is mandatory; this does not change the panel.', inputSchema: { type: 'object', properties: { reference: { type: 'string', maxLength: 36 }, changes: { type: 'object', properties: Object.fromEntries(editableFields.map(field => [field, { type: ['telegramId', 'trafficLimitBytes', 'hwidDeviceLimit'].includes(field) ? 'number' : 'string' }])), additionalProperties: false } }, required: ['reference', 'changes'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false } },
    ] }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
        try {
            const args = request.params.arguments;
            if (!args || typeof args.reference !== 'string' || args.reference.length > 36) throw new Error();
            let value;
            if (request.params.name === 'get_user_summary' && Object.keys(args).join(',') === 'reference') {
                const user = await administration.card(actorId, args.reference);
                value = { id: user.id, status: user.status, expireAt: user.expireAt, trafficLimitBytes: user.trafficLimitBytes, trafficUsedBytes: user.trafficUsedBytes, observedAt: user.observedAt };
            } else if (request.params.name === 'prepare_user_change' && Object.keys(args).sort().join(',') === 'changes,reference') {
                const ticket = await administration.prepare(actorId, args.reference, args.changes);
                value = { proposalId: ticket.id, confirmationRequired: true, expiresInSeconds: ticket.expiresInSeconds, panelChanged: false };
            } else throw new Error();
            return { content: [{ type: 'text', text: JSON.stringify(value) }] };
        } catch { return { isError: true, content: [{ type: 'text', text: 'ADMIN_REQUEST_UNAVAILABLE. No automatic retries or confirmations.' }] }; }
    });
    return server;
}
