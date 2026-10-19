import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readServerConfig } from './server-config.mjs';
import { createConfiguredService } from './configured-service.mjs';
import { readRuntimeControls } from './runtime-controls.mjs';
import { readExtensions } from './extensions.mjs';
import { validateBusinessEnv } from '../business/config.mjs';

export const baseKeys = ['REMNAWAVE_BASE_URL', 'BOT_USERNAME', 'TELEGRAM_ADMIN_ID', 'PANEL_USERS_READ_ENABLED'];
export const controlKeys = ['AI_ENABLED', 'BOT_ENHANCED_UI', 'AI_DAILY_LIMIT', 'PANEL_ALLOWED_REPORTS'];
export const extensionKeys = ['BOT_AUTO_MENU', 'VOICE_ENABLED', 'VOICE_MAX_SECONDS', 'VOICE_MAX_BYTES', 'ADMIN_USER_READ_ENABLED', 'ADMIN_WRITE_ENABLED', 'ADMIN_ALLOWED_FIELDS', 'ADMIN_RENEWAL_DAYS', 'BUSINESS_ENABLED', 'SUPPORT_AI_ENABLED'];
export function validateExtensionConfiguration(text) { return readExtensions(parsePrivateEnv(text, extensionKeys)); }
export function validateBusinessConfiguration(text) { return validateBusinessEnv(parsePrivateEnv(text, ['PORTAL_ENABLED', 'PORTAL_PUBLIC_ORIGIN', 'PORTAL_PANEL_READ_ENABLED', 'REMNAWAVE_BASE_URL', 'BILLING_MANUAL_ENABLED', 'BILLING_RECONCILIATION_ENABLED', 'BILLING_REVIEW_DELAY_SECONDS', 'SUPPORT_AI_ENABLED', 'PLAN_DAYS', 'PLAN_RUB_UNITS', 'PLAN_USDT_UNITS', 'SEARCH_ENABLED', 'SEARCH_DAILY_LIMIT', 'SEARCH_ALLOWED_HOSTS', 'MEDIA_ENABLED', 'MEDIA_MAX_BYTES', 'MEDIA_ALLOWED_APPS'])); }

export function parsePrivateEnv(text, keys) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 4096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error('INVALID_PRIVATE_CONFIGURATION');
    const env = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const match = line.match(/^([A-Z_]+)=([^\s$`"'\\]+)$/);
        if (!match || !keys.includes(match[1]) || Object.hasOwn(env, match[1])) throw new Error('INVALID_PRIVATE_CONFIGURATION');
        env[match[1]] = match[2];
    }
    return env;
}

export function validateBaseConfiguration(text) {
    const env = parsePrivateEnv(text, baseKeys);
    const config = readServerConfig(env);
    createConfiguredService({ baseUrl: config.baseUrl, tokenFile: '/not-mounted', usersEnabled: config.usersEnabled });
    return true;
}

export function validateControlConfiguration(text) {
    const env = parsePrivateEnv(text, controlKeys);
    if (controlKeys.some(key => !Object.hasOwn(env, key)) || !['true', 'false'].includes(env.AI_ENABLED) || !['true', 'false'].includes(env.BOT_ENHANCED_UI)) throw new Error('INVALID_PRIVATE_CONFIGURATION');
    return readRuntimeControls(env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const args = process.argv.slice(2);
        if (args.length !== 2 || !['base', 'controls', 'extensions', 'business'].includes(args[0]) || args[1] !== '/configuration.env' || statSync(args[1]).size > 4096) throw new Error('INVALID_PRIVATE_CONFIGURATION');
        const text = readFileSync(args[1], 'utf8');
        if (args[0] === 'base') validateBaseConfiguration(text);
        else if (args[0] === 'controls') validateControlConfiguration(text);
        else if (args[0] === 'extensions') validateExtensionConfiguration(text);
        else validateBusinessConfiguration(text);
        process.stdout.write('Configuration valid; no network or credential files accessed.\n');
    } catch {
        process.stderr.write('Configuration rejected. Check known keys and allowed values; no private values were printed.\n');
        process.exitCode = 2;
    }
}
