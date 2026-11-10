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
    function card(thread, notice = '') {
        if (!ticketId(thread?.id) || !Number.isSafeInteger(thread.panelId) || thread.panelId <= 0 || !ticketId(thread.version) || !Array.isArray(thread.history)) throw new Error('SUPPORT_UNAVAILABLE');
        while (cards.size >= 20) cards.delete(cards.keys().next().value);
        const key = randomBytes(9).toString('base64url');
        cards.set(key, { id: thread.id, panelId: thread.panelId, version: thread.version, at: now() });
        const history = thread.history.slice(-6).map(item => `<b>${item.role === 'user' ? 'Клиент' : 'Поддержка'}:</b> ${clipped(item.text)}`).join('\n\n');
        return screen(`<b>💬 Поддержка · пользователь #${thread.panelId}</b>\n\n${history}\n\n${notice || 'Нажмите «Ответить» или используйте ответ Telegram на эту карточку. Сообщение попадёт в переписку этого клиента в кабинете.'}`, [[{ text: '✍️ Ответить', callback_data: `bsr:${key}` }, { text: '🔄 Обновить', callback_data: `bh:${thread.id}` }], [{ text: '✅ Завершить диалог', callback_data: `bsc:${key}` }], ...(thread.media ?? []).filter(item => ticketId(item.id)).slice(0, 5).map(item => [{ text: '📷 Текст вложения', callback_data: `bm:${item.id}` }])], thread.id);
    }
    const expired = () => screen('Выберите актуальную карточку обращения. Ответ не отправлен.');
    async function send(target, text, updateId) {
        composing = undefined;
        if (typeof text !== 'string' || !text.trim() || text.length > 500) return screen('Ответ должен содержать от 1 до 500 символов. Откройте «Ответить» и отправьте текст заново.', [[{ text: '💬 К диалогу', callback_data: `bh:${target.id}` }]], target.id);
        if (!Number.isSafeInteger(updateId) || updateId < 0) return expired();
        const key = randomBytes(16).toString('hex');
        try {
            const result = await call('/support-message', { id: target.id, key, text });
            if (result?.recorded !== true) throw new Error('SUPPORT_UNAVAILABLE');
        } catch {
            return screen('Результат доставки требует проверки. Откройте обновлённый диалог перед повтором: сообщение могло сохраниться. Автоматической повторной отправки нет.', [[{ text: '🔄 Проверить переписку', callback_data: `bh:${target.id}` }]], target.id);
        }
        try { return card(await call('/support/' + target.id), '✅ Ответ доставлен в переписку клиента. Диалог остаётся открытым.'); }
        catch { return screen('✅ Ответ сохранён. Обновите диалог для просмотра переписки.', [[{ text: '🔄 Обновить', callback_data: `bh:${target.id}` }]], target.id); }
    }
    return {
        delivered(context, result) {
            if (!ticketId(context) || !Number.isSafeInteger(result?.message_id) || result.message_id <= 0 || result.chat?.id !== actorId || ![...cards.values()].some(item => item.id === context && valid(item))) return;
            while (bindings.size >= 20) bindings.delete(bindings.keys().next().value);
            bindings.set(result.message_id, { id: context, at: now() });
        },
        async handle({ text, data, allowedUserId, replyToMessageId, telegramReply, updateId, telegramForward, inputSource }) {
            if (allowedUserId !== actorId || telegramForward) return null;
            const action = data?.match(/^(bsr|bsc):([A-Za-z0-9_-]{12})$/);
            const opening = data?.match(/^bh:([a-f0-9]{24})$/);
            if (data && !action) composing = undefined;
            if ((composing && (text === '/cancel' || text?.toLowerCase() === 'отмена')) || data === 'bsx') { composing = undefined; return screen('Ввод ответа отменён.'); }
            if (text?.startsWith('/') && !telegramReply) composing = undefined;
            try {
                if (opening) return card(await call('/support/' + opening[1]));
                if (action) {
                    const target = cards.get(action[2]);
                    if (!valid(target)) return expired();
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
                    composing = { ...target, at: now() };
                    const output = card(thread, '<b>✍️ Напишите ответ обычным текстовым сообщением, до 500 символов.</b>\nСледующее сообщение отправится этому клиенту. Ввод действует 3 минуты.');
                    output.reply_markup.inline_keyboard.unshift([{ text: 'Отмена ответа', callback_data: 'bsx' }]);
                    return output;
                }
                if (telegramReply) {
                    const target = bindings.get(replyToMessageId);
                    if (!valid(target)) return expired();
                    if (inputSource === 'local-voice') return screen('Для ответа клиенту отправьте текст. Голосовой ответ не отправлен.', [[{ text: '💬 К диалогу', callback_data: `bh:${target.id}` }]], target.id);
                    return send(target, text, updateId);
                }
                if (composing && !data) {
                    const target = composing;
                    if (!valid(target) || now() - target.at >= 180000) { composing = undefined; return expired(); }
                    if (inputSource === 'local-voice') return screen('Для ответа клиенту нужен текст. Отправка голосом не выполнялась.', [[{ text: 'Отмена ответа', callback_data: 'bsx' }]], target.id);
                    return send(target, text, updateId);
                }
                if (/^(?:bsr:|bsc:)/.test(data ?? '')) return expired();
                return null;
            } catch { composing = undefined; return screen('Диалог недоступен или изменился. Откройте актуальную карточку. Действие автоматически не повторяется.'); }
        },
    };
}
