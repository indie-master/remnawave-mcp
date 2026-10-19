import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createConfiguredService } from './configured-service.mjs';
import { createTelegramApi } from '../telegram-client/telegram-api.mjs';
import { readRunOptions, readServerConfig } from './server-config.mjs';
import { runServerBot } from './server-loop.mjs';
import { createIntentStore } from './intent-store.mjs';
import { createBudgetedIntent } from './budgeted-intent.mjs';
import { createRunSafety, waitForOperator } from './run-safety.mjs';
import { createClassifierClient } from './ai-client.mjs';
import { readExtensions } from './extensions.mjs';
import { createVoiceInput } from './voice-client.mjs';
import { createUserClient, createUserAdministration, createAdminHandler } from './admin-users.mjs';
import { createBusinessAdmin } from './business-client.mjs';

const controller = new AbortController();
const stop = () => controller.abort();
let timer;
let safety;
let intentStore;
let reports;
let administration;
const event = data => process.stdout.write(JSON.stringify({ observedAt: new Date().toISOString(), ...data }) + '\n');
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
async function main() {
    const options = readRunOptions(process.argv.slice(2));
    const directory = process.env.BOT_STATE_DIRECTORY ?? '/state';
    if (!isAbsolute(directory)) throw new Error('INVALID_SERVER_CONFIGURATION');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    safety = createRunSafety({ directory });
    const previous = safety.read();
    if (previous.mode === 'paused') {
        event({ status: 'paused', reason: previous.reason, externalCalls: false });
        const heartbeat = () => writeFileSync(join(directory, 'heartbeat.json'), JSON.stringify({ observedAt: Date.now(), phase: 'paused' }), { mode: 0o600 });
        heartbeat();
        await waitForOperator({ signal: controller.signal, heartbeat });
        return;
    }
    const config = readServerConfig(process.env);
    const extensions = readExtensions(process.env);
    const service = createConfiguredService({ baseUrl: config.baseUrl, tokenFile: config.panelTokenFile, usersEnabled: config.usersEnabled, allowedReports: config.allowedReports, signal: controller.signal });
    if (statSync(config.telegramTokenFile).size > 4096) throw new Error('INVALID_LOCAL_CREDENTIAL');
    const token = readFileSync(config.telegramTokenFile, 'utf8').trim();
    const apiOptions = { token, allowedUserId: config.allowedUserId, enableButtons: true };
    const api = createTelegramApi({ ...apiOptions, signal: controller.signal });
    const finalApi = createTelegramApi(apiOptions);
    if (extensions.adminRead) administration = createUserAdministration({ filename: join(config.stateDirectory, 'admin.sqlite'), client: createUserClient({ baseUrl: config.baseUrl, readTokenFile: config.panelTokenFile, signal: controller.signal }), actorId: config.allowedUserId, readEnabled: true, writeEnabled: extensions.adminWrite, allowedFields: extensions.adminFields });
    const userHandler = administration ? createAdminHandler({ administration, actorId: config.allowedUserId, renewalDays: extensions.renewalDays }) : undefined;
    const businessHandler = extensions.business ? createBusinessAdmin({ actorId: config.allowedUserId, administration }) : undefined;
    const offsetFile = join(config.stateDirectory, 'offset.json');
    const heartbeatFile = join(config.stateDirectory, 'heartbeat.json');
    let classify;
    let aiClient;
    try {
        intentStore = createIntentStore({ filename: join(config.stateDirectory, 'intent-cache.sqlite'), dailyLimit: config.dailyLimit });
        aiClient = config.aiEnabled ? createClassifierClient({ signal: controller.signal }) : undefined;
        classify = createBudgetedIntent({ store: intentStore, classify: aiClient, onEvent: event });
    } catch { event({ event: 'intent', ok: false, code: 'AI_STATE_UNAVAILABLE' }); }
    const result = await runServerBot({
        ...options, api, service, allowedUserId: config.allowedUserId, botUsername: config.botUsername, signal: controller.signal,
        classify, budgetStatus: intentStore ? async () => { const local = intentStore.status(); try { return { ...local, shared: await aiClient?.usage() }; } catch { return local; } } : undefined, enhancedUi: config.enhancedUi, aiEnabled: config.aiEnabled && !!classify,
        autoMenu: extensions.autoMenu,
        extraButtons: [...(userHandler ? [[{ text: '👤 Найти пользователя', callback_data: 'admin_home' }]] : []), ...(businessHandler ? [[{ text: '💳 Оплаты и продления', callback_data: 'business_home' }]] : [])],
        voiceInput: extensions.voice ? createVoiceInput({ api, allowedUserId: config.allowedUserId, maxSeconds: extensions.voiceSeconds, maxBytes: extensions.voiceBytes }) : undefined,
        adminHandle: userHandler || businessHandler ? async request => (await userHandler?.(request)) ?? (await businessHandler?.(request)) : undefined,
        textModeDescription: classify ? (config.aiEnabled ? `Знакомые вопросы — локально; новые — через подписку Codex, до ${config.dailyLimit} попыток в сутки. Данные обновляются через MCP.` : 'Знакомые вопросы распознаются локально, данные обновляются через MCP. Новые вопросы через ИИ ещё не включены.') : undefined,
        mcpRead: classify ? async (action, days) => {
            if (controller.signal.aborted) throw new Error('STOP_REQUESTED');
            reports ??= await (await import('./report-mcp.mjs')).connectReportMcp(service);
            return reports.read(action, days);
        } : undefined,
        loadOffset: () => {
            try {
                if (statSync(offsetFile).size > 128) throw new Error('INVALID_STATE');
                const data = JSON.parse(readFileSync(offsetFile, 'utf8'));
                if (!data || Object.keys(data).join(',') !== 'offset') throw new Error('INVALID_STATE');
                return data.offset;
            } catch (error) {
                if (error?.code === 'ENOENT') return undefined;
                throw new Error('INVALID_STATE');
            }
        },
        saveOffset: offset => {
            writeFileSync(offsetFile + '.tmp', JSON.stringify({ offset }), { mode: 0o600 });
            renameSync(offsetFile + '.tmp', offsetFile);
        },
        heartbeat: () => writeFileSync(heartbeatFile, JSON.stringify({ observedAt: Date.now(), phase: 'ready' }), { mode: 0o600 }),
        onEvent: event,
        onReady: data => {
            if (!options.continuous) timer = setTimeout(stop, options.seconds * 1000);
            event(data);
        },
        sendFinal: finalApi.sendReply,
    });
    event(result);
    safety.record(result);
    if (result.status === 'failed') process.exitCode = 1;
}
try {
    await main();
} catch {
    try { safety?.record({ status: 'failed', startedAt: null, stoppedAt: new Date().toISOString() }); } catch {}
    process.stderr.write('Server bot not started or unavailable. Verify explicit startup approval, configuration and credential files. No private details were printed.\n');
    process.exitCode = 2;
} finally {
    clearTimeout(timer);
    controller.abort();
    await reports?.close();
    intentStore?.close();
    administration?.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
}
