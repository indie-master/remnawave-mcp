import { createCustomerHandler } from './handler.mjs';
import { createReadRetry, receiverCause } from '../telegram-admin/network-retry.mjs';

export async function runCustomerBot({ api, call, config, signal, now = Date.now, sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), loadOffset = () => undefined, saveOffset = () => {}, heartbeat = () => {}, onEvent = () => {} }) {
    const result = { status: 'stopped', reason: 'STOP_REQUESTED', startedAt: new Date(now()).toISOString() };
    let phase = 'configuration';
    const read = createReadRetry({ signal: signal ?? new AbortController().signal, sleep, heartbeat, onEvent });
    try {
        if (!config.enabled || config.username.toLowerCase() === config.adminUsername.toLowerCase()) throw new Error('BOT_IDENTITY_MISMATCH');
        phase = 'get_me'; const identity = await read(() => api.getMe(), phase);
        if (!Number.isSafeInteger(identity?.id) || identity.id <= 0 || identity.is_bot !== true || identity.username?.toLowerCase() !== config.username.toLowerCase() || identity.username.toLowerCase() === config.adminUsername.toLowerCase()) throw new Error('BOT_IDENTITY_MISMATCH');
        phase = 'webhook'; const webhook = await read(() => api.getWebhookInfo(), phase); if (webhook?.url !== '') throw new Error('WEBHOOK_BLOCKED');
        phase = 'gateway'; const ready = await read(() => call('/ready'), phase); if (!ready?.ready || ready.botUsername?.toLowerCase() !== config.username.toLowerCase()) throw new Error('BOT_IDENTITY_MISMATCH');
        phase = 'registration'; await read(() => call('/identity', { botId: identity.id, username: identity.username }), phase);
        if (ready.miniAppUrl && api.setMiniAppMenu) {
            try { await api.setMiniAppMenu(ready.miniAppUrl); }
            catch (error) { onEvent({ event: 'menu_setup', ok: false, code: receiverCause(error) }); }
        }
        phase = 'offset';
        let offset = await loadOffset(); if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) throw new Error('INVALID_STATE');
        const handle = createCustomerHandler({ call, send: api.send, edit: api.edit, answerCallback: api.answerCallback, botId: identity.id, miniAppUrl: ready.miniAppUrl, now });
        onEvent({ ready: true, customerBot: true, subscriptionAi: false });
        heartbeat();
        while (!signal?.aborted) {
            let updates;
            phase = 'poll'; updates = await read(() => api.getUpdates(offset), phase);
            if (!Array.isArray(updates) || updates.length > 20 || updates.some(item => !Number.isSafeInteger(item?.update_id) || item.update_id < 0 || item.update_id >= Number.MAX_SAFE_INTEGER)) throw new Error('INVALID_STATE');
            for (const update of updates.sort((a, b) => a.update_id - b.update_id)) {
                if (signal?.aborted) break;
                if (offset !== undefined && update.update_id < offset) continue;
                offset = update.update_id + 1; phase = 'offset'; await saveOffset(offset);
                phase = 'delivery';
                try { await handle(update); } catch { onEvent({ event: 'delivery', code: 'CUSTOMER_DELIVERY_UNCERTAIN' }); }
                heartbeat();
            }
            if (signal?.aborted) break;
            try {
                const response = await call('/deliveries/claim', {}); const item = response?.delivery;
                if (item) {
                    if (!/^[a-f0-9]{24}$/.test(item.id ?? '') || !/^[A-Za-z0-9_-]{32}$/.test(item.lease ?? '') || !Number.isSafeInteger(item.telegramId) || item.telegramId <= 0 || typeof item.text !== 'string' || item.text.length < 1 || item.text.length > 500) throw new Error('INVALID_DELIVERY');
                    let outcome = 'uncertain';
                    try {
                        const text = item.text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
                        const sent = await api.send(item.telegramId, '<b>Ответ поддержки</b>\n\n' + text);
                        if (sent?.chat?.id === item.telegramId && Number.isSafeInteger(sent.message_id) && sent.message_id > 0) outcome = 'done';
                    } catch {}
                    await call('/deliveries/settle', { id: item.id, lease: item.lease, outcome });
                }
            } catch { onEvent({ event: 'delivery', code: 'CUSTOMER_GATEWAY_UNAVAILABLE' }); }
            heartbeat(); await sleep(100);
        }
    } catch (error) {
        if (signal?.aborted) { result.stoppedAt = new Date(now()).toISOString(); return result; }
        const code = error?.code ?? error?.message;
        result.status = ['BOT_IDENTITY_MISMATCH', 'WEBHOOK_BLOCKED', 'RECEIVER_CONFLICT', 'INVALID_STATE'].includes(code) ? 'blocked' : 'failed';
        result.reason = result.status === 'blocked' ? code : 'CONNECTION_OR_CONFIGURATION_FAILED';
        result.cause = receiverCause(error); result.phase = phase;
    }
    result.stoppedAt = new Date(now()).toISOString(); return result;
}
