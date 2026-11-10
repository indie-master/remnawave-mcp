import { randomBytes } from 'node:crypto';

export function createMenuSession({ api, handle, allowedUserId, collapsible = false, canDeliver = () => true, onDelivery = () => {}, nonce = () => randomBytes(6).toString('base64url') }) {
    let anchor;
    let token;
    let busy = false;
    let lastUpdateId = -1;
    let expandedPayload;
    const conversations = new Map();
    const authorized = update => {
        const callback = update?.callback_query;
        const message = callback?.message ?? update?.message;
        const from = callback?.from ?? message?.from;
        return message?.chat?.type === 'private' && message.chat.id === allowedUserId && from?.id === allowedUserId && from.is_bot === false;
    };
    async function send(payload, edit, collapsed = false) {
        if (!canDeliver()) return 0;
        if (/^[a-f0-9]{24}$/.test(payload.supportContext ?? '')) return sendConversation(payload);
        const nextToken = nonce();
        if (!/^[A-Za-z0-9_-]{8}$/.test(nextToken)) throw new Error('INVALID_MENU_TOKEN');
        if (!collapsed) expandedPayload = payload;
        const rows = collapsed ? [[{ text: '🏠 Открыть меню', callback_data: 'ui_expand' }]] : [...(payload.reply_markup?.inline_keyboard ?? []), ...(collapsible ? [[{ text: '➖ Свернуть', callback_data: 'ui_collapse' }]] : [])];
        const markup = rows.length ? { inline_keyboard: rows.map(row => row.map(button => button.callback_data === undefined ? { ...button } : { ...button, callback_data: `m:${nextToken}:${button.callback_data}` })) } : undefined;
        const output = { ...payload, ...(markup ? { reply_markup: markup } : {}) };
        if (edit && anchor !== undefined) {
            try { await api.editReply({ ...output, message_id: anchor }); token = nextToken; return 1; }
            catch (error) {
                if (error?.code !== 'EDIT_UNAVAILABLE') throw error;
                anchor = undefined;
                token = undefined;
            }
        }
        const result = await api.sendReply(output);
        if (!Number.isSafeInteger(result?.message_id) || result.message_id <= 0 || result.chat?.id !== allowedUserId) {
            anchor = undefined;
            token = undefined;
            return 1;
        }
        anchor = result.message_id;
        token = nextToken;
        return 1;
    }
    async function sendConversation(payload) {
        const { supportContext, ...body } = payload;
        const previous = conversations.get(supportContext);
        const nextToken = nonce();
        if (!/^[A-Za-z0-9_-]{8}$/.test(nextToken)) throw new Error('INVALID_MENU_TOKEN');
        const output = { ...body, reply_markup: { inline_keyboard: (body.reply_markup?.inline_keyboard ?? []).map(row => row.map(button => button.callback_data === undefined ? { ...button } : { ...button, callback_data: `m:${nextToken}:${button.callback_data}` })) } };
        if (previous) {
            try {
                await api.editReply({ ...output, message_id: previous.messageId });
                conversations.set(supportContext, { messageId: previous.messageId, token: nextToken });
                onDelivery(supportContext, { message_id: previous.messageId, chat: { id: allowedUserId } }); return 1;
            } catch (error) { if (error?.code !== 'EDIT_UNAVAILABLE') throw error; conversations.delete(supportContext); }
        }
        const result = await api.sendReply(output);
        if (Number.isSafeInteger(result?.message_id) && result.message_id > 0 && result.chat?.id === allowedUserId) {
            while (conversations.size >= 20) conversations.delete(conversations.keys().next().value);
            conversations.set(supportContext, { messageId: result.message_id, token: nextToken });
            onDelivery(supportContext, result);
        }
        return 1;
    }
    return {
        open: payload => send(payload, anchor !== undefined),
        async process(update) {
            if (!authorized(update) || busy || !Number.isSafeInteger(update.update_id) || update.update_id < 0 || update.update_id <= lastUpdateId) return 0;
            lastUpdateId = update.update_id;
            busy = true;
            try {
                const callback = update.callback_query;
                if (callback) {
                    if (typeof callback.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(callback.id) || typeof callback.data !== 'string' || callback.data.length > 64) return 0;
                    const match = typeof callback.data === 'string' && callback.data.match(/^m:([A-Za-z0-9_-]{8}):([A-Za-z0-9_:-]{1,53})$/);
                    const conversation = [...conversations.values()].find(item => item.messageId === callback.message.message_id && item.token === match?.[1]);
                    if (conversation) {
                        const reply = await handle({ ...update, callback_query: { ...callback, data: match[2] } });
                        return reply ? send(reply, true) : 0;
                    }
                    if (!match || match[1] !== token || callback.message.message_id !== anchor) {
                        if (typeof callback.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(callback.id)) {
                            try { await api.answerCallback(callback.id, 'Это меню устарело. Откройте актуальное меню: /menu.'); }
                            catch (error) { if (!['NETWORK_FAILED', 'CALLBACK_EXPIRED'].includes(error?.code)) throw error; }
                        }
                        if (anchor !== undefined) return 0;
                        const reply = { chat_id: allowedUserId, protect_content: true, parse_mode: 'HTML', text: 'Это меню устарело. Откройте актуальное меню: /menu.', reply_markup: { inline_keyboard: [[{ text: '🏠 Открыть меню', callback_data: 'home' }]] } };
                        return send(reply, true);
                    }
                    if (collapsible && ['ui_expand', 'ui_collapse'].includes(match[2])) {
                        await api.answerCallback(callback.id).catch(error => { if (!['NETWORK_FAILED', 'CALLBACK_EXPIRED'].includes(error?.code)) throw error; });
                        if (!expandedPayload) return 0;
                        return send(expandedPayload, true, match[2] === 'ui_collapse');
                    }
                    const reply = await handle({ ...update, callback_query: { ...callback, data: match[2] } });
                    return reply ? send(reply, true) : 0;
                }
                const reply = await handle(update);
                return reply ? send(reply, false) : 0;
            } finally { busy = false; }
        },
    };
}
