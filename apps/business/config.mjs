export function validateBusinessEnv(env) {
    for (const key of ['PORTAL_ENABLED', 'PORTAL_PANEL_READ_ENABLED', 'BILLING_MANUAL_ENABLED', 'BILLING_RECONCILIATION_ENABLED', 'SUPPORT_AI_ENABLED', 'SEARCH_ENABLED', 'MEDIA_ENABLED']) if (!['true', 'false'].includes(env[key] ?? 'false')) throw new Error('INVALID_BUSINESS_CONFIGURATION');
    if ((env.BILLING_RECONCILIATION_ENABLED === 'true' && env.BILLING_MANUAL_ENABLED !== 'true') || !/^[1-9]\d{2,4}$/.test(env.BILLING_REVIEW_DELAY_SECONDS ?? '900') || Number(env.BILLING_REVIEW_DELAY_SECONDS ?? 900) < 300 || Number(env.BILLING_REVIEW_DELAY_SECONDS ?? 900) > 86400) throw new Error('INVALID_BUSINESS_CONFIGURATION');
    const origin = new URL(env.PORTAL_PUBLIC_ORIGIN);
    if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname))) || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash) throw new Error('INVALID_BUSINESS_CONFIGURATION');
    const panel = new URL(env.REMNAWAVE_BASE_URL);
    if (panel.protocol !== 'https:' || panel.pathname !== '/' || panel.username || panel.password || panel.search || panel.hash) throw new Error('INVALID_BUSINESS_CONFIGURATION');
    for (const name of ['PLAN_RUB_UNITS', 'PLAN_USDT_UNITS']) if (!/^(0|[1-9]\d{0,10})$/.test(env[name] ?? '0')) throw new Error('INVALID_BUSINESS_CONFIGURATION');
    if (!/^[1-9]\d{0,2}$/.test(env.PLAN_DAYS ?? '30') || Number(env.PLAN_DAYS ?? 30) > 366) throw new Error('INVALID_BUSINESS_CONFIGURATION');
    if (!/^(?:[0-9]|10)$/.test(env.SEARCH_DAILY_LIMIT ?? '0') || (env.SEARCH_ALLOWED_HOSTS ?? 'docs.rw').split(',').some(host => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host))) throw new Error('INVALID_BUSINESS_CONFIGURATION');
    if (!/^[1-9]\d{0,7}$/.test(env.MEDIA_MAX_BYTES ?? '5242880') || Number(env.MEDIA_MAX_BYTES ?? 5242880) > 10485760 || !/^[a-z0-9]+(?:,[a-z0-9]+){0,9}$/.test(env.MEDIA_ALLOWED_APPS ?? 'happ')) throw new Error('INVALID_BUSINESS_CONFIGURATION');
    return true;
}
