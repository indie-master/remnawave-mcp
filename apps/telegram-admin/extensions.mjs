import { nodeUuidPattern, positiveId } from './admin-panel-actions.mjs';
import { parseGigabytes, trafficStrategies } from './admin-display.mjs';

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
    const createSquads = targetList('ADMIN_CREATE_SQUADS', uuid => nodeUuidPattern.test(uuid));
    const squadNames = env.ADMIN_CREATE_SQUAD_NAMES === undefined || env.ADMIN_CREATE_SQUAD_NAMES === 'none' ? [] : env.ADMIN_CREATE_SQUAD_NAMES.split(',');
    const usernamePart = name => env[name] === undefined || env[name] === 'none' ? '' : env[name];
    const prefix = usernamePart('ADMIN_CREATE_USERNAME_PREFIX');
    const suffix = usernamePart('ADMIN_CREATE_USERNAME_SUFFIX');
    const telegramNameSource = env.ADMIN_CREATE_TG_NAME_SOURCE ?? 'profile';
    if (squadNames.length + createSquads.length > 10 || new Set(squadNames).size !== squadNames.length || squadNames.some(name => !name.length || name.length > 64 || /[\u0000-\u0020]/.test(name)) || ![prefix, suffix].every(value => /^[A-Za-z0-9_-]{0,12}$/.test(value)) || prefix.length + suffix.length > 24 || !['username', 'profile'].includes(telegramNameSource)) throw new Error('INVALID_EXTENSION_CONFIGURATION');
    const createEnabled = flag('ADMIN_CREATE_ENABLED');
    const strategy = env.ADMIN_CREATE_TRAFFIC_STRATEGY ?? 'NO_RESET';
    const defaultGb = env.ADMIN_CREATE_DEFAULT_GB ?? 'none';
    if (!Object.hasOwn(trafficStrategies, strategy) || (defaultGb !== 'none' && !/^\d{1,8}(?:[.,]\d{1,3})?$/.test(defaultGb)) || (createEnabled && (!flag('ADMIN_WRITE_ENABLED') || !flag('ADMIN_USER_READ_ENABLED') || !(createSquads.length + squadNames.length) || defaultGb === 'none'))) throw new Error('INVALID_EXTENSION_CONFIGURATION');
    const createOptions = { enabled: createEnabled, squads: createSquads, squadNames, prefix, suffix, telegramNameSource, trafficLimitBytes: defaultGb === 'none' ? undefined : parseGigabytes(defaultGb), strategy, hwidLimit: integer('ADMIN_CREATE_HWID_LIMIT', 4, 100) };
    const renewalDays = (env.ADMIN_RENEWAL_DAYS ?? '1,7,30,90').split(',').map(value => /^[1-9]\d{0,2}$/.test(value) ? Number(value) : NaN);
    if (!renewalDays.length || renewalDays.length > 8 || new Set(renewalDays).size !== renewalDays.length || renewalDays.some(value => !Number.isInteger(value) || value > 366)) throw new Error('INVALID_EXTENSION_CONFIGURATION');
    if (!adminFields.length || new Set(adminFields).size !== adminFields.length || adminFields.some(field => !['status', 'expireAt', 'description', 'email', 'telegramId', 'trafficLimitBytes', 'tag', 'hwidDeviceLimit', 'trafficLimitStrategy'].includes(field)) || (flag('ADMIN_WRITE_ENABLED') && !flag('ADMIN_USER_READ_ENABLED'))) throw new Error('INVALID_EXTENSION_CONFIGURATION');
    return {
        autoMenu: flag('BOT_AUTO_MENU', true), voice: flag('VOICE_ENABLED'),
        business: flag('BUSINESS_ENABLED'), supportAi: flag('SUPPORT_AI_ENABLED'),
        voiceSeconds: integer('VOICE_MAX_SECONDS', 30, 60), voiceBytes: integer('VOICE_MAX_BYTES', 1048576, 2097152),
        adminRead: flag('ADMIN_USER_READ_ENABLED'), adminWrite: flag('ADMIN_WRITE_ENABLED'),
        adminFields, renewalDays, actionUserIds, actionNodeUuids, destructiveUserActions: flag('ADMIN_DESTRUCTIVE_USER_ACTIONS'), squadEdit: flag('ADMIN_SQUAD_EDIT_ENABLED'), createOptions,
    };
}
