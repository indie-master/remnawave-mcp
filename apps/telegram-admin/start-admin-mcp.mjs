import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { join } from 'node:path';
import { readServerConfig } from './server-config.mjs';
import { readExtensions } from './extensions.mjs';
import { createUserAdministration, createUserClient } from './admin-users.mjs';
import { createAdministrationMcp } from './admin-mcp.mjs';

let administration;
try {
    if (process.argv.slice(2).join(' ') !== '--stdio --confirm-admin-context') throw new Error('ADMIN_CONTEXT_NOT_CONFIRMED');
    const config = readServerConfig(process.env); const extensions = readExtensions(process.env);
    if (!extensions.adminRead) throw new Error('ADMIN_DISABLED');
    administration = createUserAdministration({ filename: join(config.stateDirectory, 'admin.sqlite'), actorId: config.allowedUserId, readEnabled: true, writeEnabled: extensions.adminWrite, allowedFields: extensions.adminFields, client: createUserClient({ baseUrl: config.baseUrl, readTokenFile: config.panelTokenFile }) });
    const server = createAdministrationMcp(administration, config.allowedUserId);
    server.onclose = () => administration.close();
    await server.connect(new StdioServerTransport());
} catch { administration?.close(); process.stderr.write('Administrative MCP unavailable; no credentials printed.\n'); process.exitCode = 2; }
