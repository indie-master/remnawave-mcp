import { createCustomerHandler } from './handler.mjs';

export async function runCustomerBot({ api, call, config, signal, now = Date.now, sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), loadOffset = () => undefined, saveOffset = () => {}, heartbeat = () => {}, onEvent = () => {} }) {
    const result = { status: 'stopped', reason: 'STOP_REQUESTED', startedAt: new Date(now()).toISOString() };
    try {
        if (!config.enabled || config.username.toLowerCase() === config.adminUsername.toLowerCase()) throw new Error('BOT_IDENTITY_MISMATCH');
        const identity = await api.getMe();
        if (!Number.isSafeInteger(identity?.id) || identity.id <= 0 || identity.is_bot !== true || identity.username?.toLowerCase() !== config.username.toLowerCase() || identity.username.toLowerCase() === config.adminUsername.toLowerCase()) throw new Error('BOT_IDENTITY_MISMATCH');
        const webhook = await api.getWebhookInfo(); if (webhook?.url !== '') throw new Error('WEBHOOK_BLOCKED');
        const ready = await call('/ready'); if (!ready?.ready || ready.botUsername?.toLowerCase() !== config.username.toLowerCase()) throw new Error('BOT_IDENTITY_MISMATCH');
        await call('/identity', { botId: identity.id, username: identity.username });
        if (ready.miniAppUrl && api.setMiniAppMenu) await api.setMiniAppMenu(ready.miniAppUrl);
        let offset = await loadOffset(); if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) throw new Error('INVALID_STATE');
        const handle = createCustomerHandler({ call, send: api.send, edit: api.edit, answerCallback: api.answerCallback, botId: identity.id, miniAppUrl: ready.miniAppUrl, now });
        onEvent({ ready: true, customerBot: true, subscriptionAi: false });
        let errors = 0;
        while (!signal?.aborted) {
            let updates;
            try { updates = await api.getUpdates(offset); errors = 0; }
            catch (error) { if (error?.code !== 'NETWORK_FAILED' || ++errors > 6) throw error; onEvent({ event: 'poll', code: 'NETWORK_FAILED' }); await sleep(Math.min(30000, 1000 * 2 ** errors)); continue; }
            if (!Array.isArray(updates) || updates.length > 20 || updates.some(item => !Number.isSafeInteger(item?.update_id) || item.update_id < 0 || item.update_id >= Number.MAX_SAFE_INTEGER)) throw new Error('INVALID_STATE');
            for (const update of updates.sort((a, b) => a.update_id - b.update_id)) {
                if (signal?.aborted) break;
                if (offset !== undefined && update.update_id < offset) continue;
                offset = update.update_id + 1; await saveOffset(offset);
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
    }
    result.stoppedAt = new Date(now()).toISOString(); return result;
}
