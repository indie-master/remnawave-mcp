const username = value => typeof value === 'string' && /^(?=.{5,32}$)[A-Za-z0-9_]+bot$/i.test(value);
export function validateCustomerSettings(env) {
    if (!['true', 'false'].includes(env.CUSTOMER_BOT_ENABLED ?? 'false') || !username(env.CUSTOMER_BOT_USERNAME)) throw new Error('INVALID_CUSTOMER_CONFIGURATION');
    return { enabled: env.CUSTOMER_BOT_ENABLED === 'true', username: env.CUSTOMER_BOT_USERNAME };
}
export function readCustomerConfig(env) {
    const config = validateCustomerSettings(env);
    if (!config.enabled || !username(env.ADMIN_BOT_USERNAME) || config.username.toLowerCase() === env.ADMIN_BOT_USERNAME.toLowerCase()) throw new Error('INVALID_CUSTOMER_CONFIGURATION');
    return { ...config, adminUsername: env.ADMIN_BOT_USERNAME, tokenFile: '/run/secrets/customer_telegram_token' };
}
