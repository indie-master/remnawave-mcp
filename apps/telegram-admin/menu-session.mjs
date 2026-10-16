import { randomBytes } from 'node:crypto';

export function createMenuSession({ api, handle, allowedUserId, canDeliver = () => true, nonce = () => randomBytes(6).toString('base64url') }) {
    let anchor;
    let token;
    let busy = false;
    let lastUpdateId = -1;
    const authorized = update => {
        const callback = update?.callback_query;
        const message = callback?.message ?? update?.message;
        const from = callback?.from ?? message?.from;
        return message?.chat?.type === 'private' && message.chat.id === allowedUserId && from?.id === allowedUserId && from.is_bot === false;
    };
    async function send(payload, edit) {
        if (!canDeliver()) return 0;
        const nextToken = nonce();
        if (!/^[A-Za-z0-9_-]{8}$/.test(nextToken)) throw new Error('INVALID_MENU_TOKEN');
        const markup = payload.reply_markup ? { inline_keyboard: payload.reply_markup.inline_keyboard.map(row => row.map(button => ({ ...button, callback_data: `m:${nextToken}:${button.callback_data}` }))) } : undefined;
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
    return {
        async process(update) {
            if (!authorized(update) || busy || !Number.isSafeInteger(update.update_id) || update.update_id < 0 || update.update_id <= lastUpdateId) return 0;
            lastUpdateId = update.update_id;
            busy = true;
            try {
                const callback = update.callback_query;
                if (callback) {
                    if (typeof callback.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(callback.id) || typeof callback.data !== 'string' || callback.data.length > 64) return 0;
                    const match = typeof callback.data === 'string' && callback.data.match(/^m:([A-Za-z0-9_-]{8}):([A-Za-z0-9_:-]{1,53})$/);
                    if (!match || match[1] !== token || callback.message.message_id !== anchor) {
                        if (typeof callback.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(callback.id)) {
                            try { await api.answerCallback(callback.id, 'Это меню устарело. Откройте актуальное меню: /menu.'); }
                            catch (error) { if (!['NETWORK_FAILED', 'CALLBACK_EXPIRED'].includes(error?.code)) throw error; }
                        }
                        if (anchor !== undefined) return 0;
                        const reply = { chat_id: allowedUserId, protect_content: true, parse_mode: 'HTML', text: 'Это меню устарело. Откройте актуальное меню: /menu.', reply_markup: { inline_keyboard: [[{ text: '🏠 Открыть меню', callback_data: 'home' }]] } };
                        return send(reply, true);
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
