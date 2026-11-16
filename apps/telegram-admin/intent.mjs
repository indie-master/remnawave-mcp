import { expiryWindows } from './panel-service.mjs';

export const reportActions = ['version', 'stats', 'nodes', 'expiring', 'users', 'online', 'node_details', 'hosts', 'profiles', 'internal_squads', 'external_squads', 'system', 'bandwidth', 'health'];

export function validateIntent(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'action,days' || !['help', ...reportActions].includes(value.action) || !expiryWindows.includes(value.days))
        throw new Error('INVALID_AI_INTENT');
    return { action: value.action, days: value.days };
}
