import { nodeUuidPattern, positiveId } from './admin-panel-actions.mjs';

export function readExtensions(env = {}) {
    const flag = (name, fallback = false) => {
        const value = env[name] ?? String(fallback);
        if (!['true', 'false'].includes(value)) throw new Error('INVALID_EXTENSION_CONFIGURATION');
        return value === 'true';
    };
    const integer = (name, fallback, maximum) => {
        const value = env[name] ?? String(fallback);
        if (!/^[1-9]\d*$/.test(value) || Number(value) > maximum) throw new Error('INVALID_EXTENSION_CONFIGURATION');
        return Number(value);
    };
    const adminFields = (env.ADMIN_ALLOWED_FIELDS ?? 'status,expireAt,description').split(',');
    const targetList = (name, validate) => {
        const targets = env[name] === undefined || env[name] === 'none' ? [] : env[name].split(',');
        if (targets.length > 30 || new Set(targets).size !== targets.length || targets.some(value => !validate(value))) throw new Error('INVALID_EXTENSION_CONFIGURATION');
        return targets;
    };
    const actionUserIds = targetList('ADMIN_ACTION_USER_IDS', positiveId).map(Number);
    const actionNodeUuids = targetList('ADMIN_ACTION_NODE_UUIDS', uuid => nodeUuidPattern.test(uuid));
    const renewalDays = (env.ADMIN_RENEWAL_DAYS ?? '1,7,30,90').split(',').map(value => /^[1-9]\d{0,2}$/.test(value) ? Number(value) : NaN);
    if (!renewalDays.length || renewalDays.length > 8 || new Set(renewalDays).size !== renewalDays.length || renewalDays.some(value => !Number.isInteger(value) || value > 366)) throw new Error('INVALID_EXTENSION_CONFIGURATION');
    if (!adminFields.length || new Set(adminFields).size !== adminFields.length || adminFields.some(field => !['status', 'expireAt', 'description', 'email', 'telegramId', 'trafficLimitBytes', 'tag', 'hwidDeviceLimit'].includes(field)) || (flag('ADMIN_WRITE_ENABLED') && !flag('ADMIN_USER_READ_ENABLED'))) throw new Error('INVALID_EXTENSION_CONFIGURATION');
    return {
        autoMenu: flag('BOT_AUTO_MENU', true), voice: flag('VOICE_ENABLED'),
        business: flag('BUSINESS_ENABLED'), supportAi: flag('SUPPORT_AI_ENABLED'),
        voiceSeconds: integer('VOICE_MAX_SECONDS', 30, 60), voiceBytes: integer('VOICE_MAX_BYTES', 1048576, 2097152),
        adminRead: flag('ADMIN_USER_READ_ENABLED'), adminWrite: flag('ADMIN_WRITE_ENABLED'),
        adminFields, renewalDays, actionUserIds, actionNodeUuids,
    };
}
