import { randomBytes } from 'node:crypto';

const ticketId = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const clipped = value => {
    let result = '';
    for (const character of String(value).slice(0, 300)) { const escaped = escape(character); if (result.length + escaped.length > 350) return result + '…'; result += escaped; }
    return result;
};

export function createSupportInbox({ actorId, call, now = Date.now }) {
    const cards = new Map(); const bindings = new Map();
    let composing;
    const valid = value => value && now() >= value.at && now() - value.at < 1800000;
    const screen = (text, rows = [], context) => ({ text, reply_markup: { inline_keyboard: [...rows, [{ text: '⬅ Обращения', callback_data: 'business_support' }]] }, ...(context ? { supportContext: context } : {}) });
    const controls = id => [[{ text: '🔄 Обновить диалог', callback_data: `bh:${id}` }, { text: '⏸ Выйти из переписки', callback_data: `bsl:${id}` }]];
    const waiting = (target, text) => screen((Number.isSafeInteger(target.panelId) ? `<b>💬 Поддержка · пользователь #${target.panelId}</b>\n\n` : '') + text, controls(target.id), target.id);
    function card(thread, notice = '', active = true) {
        if (!ticketId(thread?.id) || !Number.isSafeInteger(thread.panelId) || thread.panelId <= 0 || !ticketId(thread.version) || !Array.isArray(thread.history)) throw new Error('SUPPORT_UNAVAILABLE');
        if (active) composing = { id: thread.id, panelId: thread.panelId, at: now(), blocked: false };
        while (cards.size >= 20) cards.delete(cards.keys().next().value);
        const key = randomBytes(9).toString('base64url');
        cards.set(key, { id: thread.id, panelId: thread.panelId, version: thread.version, at: now() });
        const history = thread.history.slice(-6).map(item => `<b>${item.role === 'user' ? 'Клиент' : 'Поддержка'}:</b> ${clipped(item.text)}`).join('\n\n');
        const mode = active ? `<b>✍️ Сейчас вы отвечаете пользователю #${thread.panelId}.</b>\nПишите обычные сообщения подряд. Режим сохраняется до выхода, переключения или 30 минут бездействия.` : 'Режим переписки выключен. Чтобы продолжить, откройте диалог снова.';
        return screen(`<b>💬 Поддержка · пользователь #${thread.panelId}</b>\n\n${history}\n\n${notice ? notice + '\n\n' : ''}${mode}`, [...(active ? controls(thread.id) : [[{ text: '✍️ Продолжить переписку', callback_data: `bsr:${key}` }, { text: '🔄 Открыть диалог', callback_data: `bh:${thread.id}` }]]), [{ text: '✅ Завершить диалог', callback_data: `bsc:${key}` }], ...(thread.media ?? []).filter(item => ticketId(item.id)).slice(0, 5).map(item => [{ text: '📷 Текст вложения', callback_data: `bm:${item.id}` }])], thread.id);
    }
    async function loadCard(id, notice = '', active = true, panelId) {
        const thread = await call('/support/' + id);
        if (thread?.id !== id || (panelId !== undefined && thread.panelId !== panelId)) throw new Error('SUPPORT_UNAVAILABLE');
        return card(thread, notice, active);
    }
    const expired = () => screen('Выберите актуальную карточку обращения. Ответ не отправлен.');
    async function send(target, text, updateId) {
        composing = { ...target, at: now(), blocked: false };
        if (typeof text !== 'string' || !text.trim() || text.length > 500) return waiting(target, 'Ответ должен содержать от 1 до 500 символов. Исправьте текст и отправьте снова; получатель остаётся прежним.');
        if (!Number.isSafeInteger(updateId) || updateId < 0) return expired();
        const key = randomBytes(16).toString('hex');
        try {
            const result = await call('/support-message', { id: target.id, key, text });
            if (result?.recorded !== true) throw new Error('SUPPORT_UNAVAILABLE');
        } catch {
            composing = { ...target, at: now(), blocked: true };
            return waiting(target, 'Результат доставки требует проверки. Обновите диалог перед продолжением: сообщение могло сохраниться. Автоматической повторной отправки нет.');
        }
        try { return await loadCard(target.id, '✅ Ответ доставлен в переписку клиента. Диалог остаётся открытым.', true, target.panelId); }
        catch { return waiting(target, '✅ Ответ сохранён. Можно продолжать писать этому клиенту; обновите диалог для просмотра переписки.'); }
    }
    return {
        delivered(context, result) {
            const target = [...cards.values()].findLast(item => item.id === context && valid(item));
            if (!ticketId(context) || !Number.isSafeInteger(result?.message_id) || result.message_id <= 0 || result.chat?.id !== actorId || !target) return;
            while (bindings.size >= 20) bindings.delete(bindings.keys().next().value);
            bindings.set(result.message_id, { id: context, panelId: target.panelId, at: now() });
        },
        async handle({ text, data, allowedUserId, replyToMessageId, telegramReply, updateId, telegramForward, inputSource }) {
            if (allowedUserId !== actorId || telegramForward) return null;
            const action = data?.match(/^(bsr|bsc):([A-Za-z0-9_-]{12})$/);
            const opening = data?.match(/^bh:([a-f0-9]{24})$/);
            const leaving = data?.match(/^bsl:([a-f0-9]{24})$/);
            let selected = composing;
            const cancel = (composing && (text === '/cancel' || text?.toLowerCase() === 'отмена')) || data === 'bsx';
            if (data && !action && !opening) composing = undefined;
            if (!telegramReply && text?.startsWith('/')) composing = undefined;
            try {
                if (leaving || cancel) {
                    const id = leaving?.[1] ?? selected?.id; composing = undefined;
                    if (id) return screen('⏸ Вы вышли из переписки. Само обращение остаётся открытым.', [[{ text: '✍️ Продолжить переписку', callback_data: `bh:${id}` }]], id);
                    return screen('Ввод ответа отменён.');
                }
                if (opening) return await loadCard(opening[1], '', true, selected?.id === opening[1] ? selected.panelId : undefined);
                if (action) {
                    const target = cards.get(action[2]);
                    if (!valid(target)) {
                        if (target) { composing = { ...target, blocked: true }; return waiting(target, 'Карточка устарела. Обновите диалог перед продолжением.'); }
                        if (composing) composing = { ...composing, blocked: true };
                        return expired();
                    }
                    selected = target;
                    if (action[1] === 'bsc') {
                        composing = undefined;
                        const result = await call('/support-close', { id: target.id, version: target.version });
                        if (result?.closed !== true) throw new Error('SUPPORT_UNAVAILABLE');
                        for (const [key, item] of cards) if (item.id === target.id) cards.delete(key);
                        for (const [key, item] of bindings) if (item.id === target.id) bindings.delete(key);
                        return screen(`✅ Диалог пользователя #${target.panelId} завершён. Новое обращение клиента снова появится в очереди.`, [], target.id);
                    }
                    const thread = await call('/support/' + target.id);
                    if (thread?.id !== target.id || thread.panelId !== target.panelId) throw new Error('SUPPORT_UNAVAILABLE');
                    return card(thread);
                }
                if (telegramReply) {
                    const target = bindings.get(replyToMessageId);
                    if (!valid(target)) { if (target) { composing = { ...target, blocked: true }; return waiting(target, 'Переписка приостановлена после долгой паузы. Обновите диалог перед продолжением.'); } if (composing) composing = { ...composing, blocked: true }; return expired(); }
                    if (composing?.id === target.id && composing.blocked) return waiting(target, 'Сначала обновите диалог и проверьте историю доставки. Новое сообщение пока не отправлено.');
                    composing = { ...target, at: now(), blocked: false };
                    if (inputSource === 'local-voice') return waiting(target, 'Для ответа клиенту отправьте текст. Голосовой ответ не отправлен.');
                    return send(target, text, updateId);
                }
                if (composing && !data) {
                    const target = composing;
                    if (!valid(target) || target.blocked) { composing = { ...target, blocked: true }; return waiting(target, 'Переписка приостановлена. Обновите диалог перед продолжением; новое сообщение не отправлено.'); }
                    if (inputSource === 'local-voice') return waiting(target, 'Для ответа клиенту нужен текст. Отправка голосом не выполнялась.');
                    return send(target, text, updateId);
                }
                if (/^(?:bsr:|bsc:)/.test(data ?? '')) return expired();
                return null;
            } catch {
                const id = opening?.[1] ?? leaving?.[1] ?? selected?.id;
                if (id) { composing = { ...(selected?.id === id ? selected : {}), id, at: now(), blocked: true }; return waiting(composing, 'Диалог недоступен или изменился. Обновите его перед продолжением. Действие автоматически не повторяется.'); }
                composing = undefined; return screen('Диалог недоступен. Откройте актуальную карточку.');
            }
        },
    };
}
