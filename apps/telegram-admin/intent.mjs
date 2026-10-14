import { expiryWindows } from './panel-service.mjs';

export function validateIntent(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'action,days' || !['help', 'version', 'stats', 'nodes', 'expiring'].includes(value.action) || !expiryWindows.includes(value.days))
        throw new Error('INVALID_AI_INTENT');
    return { action: value.action, days: value.days };
}
