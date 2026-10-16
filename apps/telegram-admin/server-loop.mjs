import { createDashboard } from './dashboard.mjs';
import { reportActions } from './intent.mjs';
import { createMenuSession } from './menu-session.mjs';

const sleepDefault = (milliseconds, signal) => new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
});

export async function runServerBot({ api, service, allowedUserId, botUsername, classify, mcpRead, budgetStatus, textModeDescription, enhancedUi = false, aiEnabled = false, soleReceiverConfirmed = false, continuous = false, seconds = 900, signal, now = Date.now, sleep = sleepDefault, loadOffset = () => undefined, saveOffset = () => {}, heartbeat = () => {}, onEvent = () => {}, onReady = () => {}, sendFinal = payload => api.sendReply(payload) }) {
    if (soleReceiverConfirmed !== true || typeof continuous !== 'boolean' || !Number.isInteger(seconds) || seconds < 60 || seconds > 900) throw new Error('LIVE_START_NOT_AUTHORIZED');
    const result = { status: 'stopped', reason: null, replies: 0, polls: 0, startedAt: null, stoppedAt: null };
    let ready = false;
    let deadline;
    const notification = text => ({ chat_id: allowedUserId, text, protect_content: true });
    try {
        let offset = await loadOffset();
        if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) throw new Error('INVALID_STATE');
        if (signal?.aborted) throw new Error('STOP_REQUESTED');
        const identity = await api.getMe();
        if (identity?.is_bot !== true || identity.username?.toLowerCase() !== botUsername?.toLowerCase()) throw new Error('BOT_IDENTITY_MISMATCH');
        const webhook = await api.getWebhookInfo();
        if (typeof webhook?.url !== 'string' || webhook.url !== '') throw new Error('WEBHOOK_BLOCKED');
        const started = now();
        result.startedAt = new Date(started).toISOString();
        deadline = continuous ? Infinity : started + seconds * 1000;
        const guardedService = { ownerName: service.ownerName };
        for (const action of reportActions) guardedService[action] = async (...args) => {
            if (signal?.aborted || now() >= deadline) throw new Error('STOP_REQUESTED');
            return service[action](...args);
        };
        const readMcp = mcpRead ? async (action, days) => {
            if (signal?.aborted || now() >= deadline) throw new Error('STOP_REQUESTED');
            return mcpRead(action, days);
        } : undefined;
        const handle = createDashboard({ allowedUserId, service: guardedService, classify, mcpRead: readMcp, budgetStatus, textModeDescription, enhancedUi, answerCallback: api.answerCallback, now, onDiagnostic: onEvent });
        const menuSession = enhancedUi ? createMenuSession({ api, handle, allowedUserId, canDeliver: () => !signal?.aborted && now() < deadline }) : undefined;
        await api.sendReply(notification(continuous
            ? 'Бот запущен на сервере. Кнопки работают без ИИ. Отправка клиентам отключена.'
            : `Тест бота начался на ${seconds / 60} мин. Остановка: ${new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', timeStyle: 'medium' }).format(new Date(deadline))} МСК. Кнопки работают без ИИ, отправка клиентам отключена.`));
        result.replies++;
        ready = true;
        heartbeat();
        onReady({ ready: true, continuous, maxSeconds: continuous ? null : seconds, subscriptionAi: aiEnabled, cachedText: !!classify, enhancedUi, customerSending: false, startedAt: result.startedAt });
        let consecutiveErrors = 0;
        while (!signal?.aborted && now() < deadline) {
            let updates;
            try {
                updates = await api.getUpdates(offset);
                result.polls++;
                consecutiveErrors = 0;
                heartbeat();
            } catch (error) {
                if (signal?.aborted || now() >= deadline) break;
                if (error?.code !== 'NETWORK_FAILED' || ++consecutiveErrors > 6) throw error;
                onEvent({ event: 'poll', ok: false, code: 'NETWORK_FAILED' });
                await sleep(Math.min(30000, 1000 * 2 ** (consecutiveErrors - 1)), signal);
                continue;
            }
            if (!Array.isArray(updates) || updates.length > 20 || updates.some(update => !Number.isSafeInteger(update?.update_id) || update.update_id < 0 || update.update_id >= Number.MAX_SAFE_INTEGER)) throw new Error('INVALID_UPDATES');
            for (const update of [...updates].sort((first, second) => first.update_id - second.update_id)) {
                if (signal?.aborted || now() >= deadline) break;
                if (offset !== undefined && update.update_id < offset) continue;
                offset = update.update_id + 1;
                await saveOffset(offset);
                try {
                    if (menuSession) result.replies += await menuSession.process(update);
                    else {
                        const reply = await handle(update);
                        if (reply && !signal?.aborted && now() < deadline) { await api.sendReply(reply); result.replies++; }
                    }
                } catch (error) {
                        if (signal?.aborted) break;
                        if (error?.code !== 'NETWORK_FAILED') throw error;
                        onEvent({ event: 'delivery', ok: false, code: 'DELIVERY_UNCERTAIN' });
                }
                heartbeat();
            }
            await sleep(100, signal);
        }
        result.reason = now() >= deadline ? 'TIME_LIMIT' : 'STOP_REQUESTED';
    } catch (error) {
        if (signal?.aborted) result.reason = now() >= deadline ? 'TIME_LIMIT' : 'STOP_REQUESTED';
        else {
            const blocked = ['BOT_IDENTITY_MISMATCH', 'WEBHOOK_BLOCKED', 'RECEIVER_CONFLICT', 'INVALID_STATE'];
            result.status = blocked.includes(error?.code ?? error?.message) ? 'blocked' : 'failed';
            result.reason = blocked.includes(error?.code ?? error?.message) ? error.code ?? error.message : 'CONNECTION_OR_CONFIGURATION_FAILED';
        }
    } finally {
        result.stoppedAt = new Date(now()).toISOString();
        if (ready) {
            const text = result.reason === 'TIME_LIMIT' ? 'Тест завершён по таймеру. Бот остановлен, кнопки больше не отвечают. Клиентам ничего не отправлялось.' : 'Получатель команд бота остановлен. Клиентам ничего не отправлялось.';
            try { await sendFinal(notification(text)); result.replies++; }
            catch { onEvent({ event: 'shutdown_notice', ok: false, code: 'DELIVERY_UNAVAILABLE' }); }
        }
    }
    return result;
}
