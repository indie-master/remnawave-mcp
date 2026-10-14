import { isAbsolute } from 'node:path';

export function readServerConfig(env) {
    const allowedUserId = Number(env.TELEGRAM_ADMIN_ID);
    if (!/^\d+$/.test(env.TELEGRAM_ADMIN_ID ?? '') || !Number.isSafeInteger(allowedUserId) || allowedUserId <= 0 || !/^[A-Za-z0-9_]{5,32}$/.test(env.BOT_USERNAME ?? ''))
        throw new Error('INVALID_SERVER_CONFIGURATION');
    if (env.AI_ENABLED !== undefined && env.AI_ENABLED !== 'false') throw new Error('SERVER_AI_NOT_CONFIGURED');
    if (env.PANEL_USERS_READ_ENABLED !== undefined && !['true', 'false'].includes(env.PANEL_USERS_READ_ENABLED)) throw new Error('INVALID_SERVER_CONFIGURATION');
    const telegramTokenFile = env.TELEGRAM_BOT_TOKEN_FILE ?? '/run/secrets/telegram_bot_token';
    const panelTokenFile = env.REMNAWAVE_API_TOKEN_FILE ?? '/run/secrets/panel_api_token';
    const stateDirectory = env.BOT_STATE_DIRECTORY ?? '/state';
    if (![telegramTokenFile, panelTokenFile, stateDirectory].every(value => typeof value === 'string' && isAbsolute(value))) throw new Error('INVALID_SERVER_CONFIGURATION');
    return { allowedUserId, botUsername: env.BOT_USERNAME, baseUrl: env.REMNAWAVE_BASE_URL, telegramTokenFile, panelTokenFile, stateDirectory, usersEnabled: env.PANEL_USERS_READ_ENABLED === 'true' };
}

export function readRunOptions(args) {
    const hasSeconds = args.includes('--seconds');
    const continuous = args.includes('--continuous');
    const secondsIndex = args.indexOf('--seconds');
    const secondsText = hasSeconds ? args[secondsIndex + 1] : '900';
    const seconds = Number(secondsText);
    const expected = ['--live', '--confirm-sole-receiver', ...(continuous ? ['--continuous'] : []), ...(hasSeconds ? ['--seconds', secondsText] : [])];
    if (!args.includes('--live') || !args.includes('--confirm-sole-receiver') || new Set(args).size !== args.length || args.length !== expected.length || args.some(value => !expected.includes(value)) || (continuous && hasSeconds) || !/^\d+$/.test(secondsText ?? '') || !Number.isSafeInteger(seconds) || seconds < 60 || seconds > 900)
        throw new Error('LIVE_START_NOT_AUTHORIZED');
    return { soleReceiverConfirmed: true, continuous, seconds };
}
