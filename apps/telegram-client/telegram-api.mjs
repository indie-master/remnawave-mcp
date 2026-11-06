export class TelegramError extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}

export function createTelegramApi({ token, allowedUserId, fetchImpl = fetch, signal, enableButtons = false }) {
    if (typeof token !== 'string' || !/^[1-9]\d{4,19}:[A-Za-z0-9_-]{30,128}$/.test(token) || !Number.isSafeInteger(allowedUserId) || allowedUserId <= 0)
        throw new TelegramError('INVALID_LOCAL_CONFIGURATION');

    async function call(method, body) {
        let response;
        try {
            response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
                method: 'POST', redirect: 'error',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
            });
        } catch {
            throw new TelegramError(signal?.aborted ? 'STOP_REQUESTED' : 'NETWORK_FAILED');
        }
        const maxBytes = 256 * 1024;
        if (response.status === 409 || Number(response.headers.get('content-length')) > maxBytes) {
            await response.body?.cancel().catch(() => undefined);
            throw new TelegramError(response.status === 409 ? 'RECEIVER_CONFLICT' : 'TELEGRAM_REQUEST_FAILED');
        }
        const reader = response.body?.getReader();
        if (!reader) throw new TelegramError('TELEGRAM_REQUEST_FAILED');
        const chunks = [];
        let bytes = 0;
        try {
            while (true) {
                const part = await reader.read();
                if (part.done) break;
                bytes += part.value.byteLength;
                if (bytes > maxBytes) {
                    await reader.cancel().catch(() => undefined);
                    throw new TelegramError('TELEGRAM_RESPONSE_TOO_LARGE');
                }
                chunks.push(part.value);
            }
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!response.ok || payload?.ok !== true) {
                if (response.status === 400 && method === 'editMessageText') {
                    if (payload?.description === 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message') throw new TelegramError('EDIT_NOT_MODIFIED');
                    if (["Bad Request: message can't be edited", 'Bad Request: message to edit not found'].includes(payload?.description)) throw new TelegramError('EDIT_UNAVAILABLE');
                }
                if (response.status === 400 && method === 'answerCallbackQuery' && payload?.description === 'Bad Request: query is too old and response timeout expired or query ID is invalid') throw new TelegramError('CALLBACK_EXPIRED');
                throw new TelegramError('TELEGRAM_REQUEST_FAILED');
            }
            return payload.result;
        } catch (error) {
            if (error instanceof TelegramError) throw error;
            throw new TelegramError(signal?.aborted ? 'STOP_REQUESTED' : 'TELEGRAM_RESPONSE_INVALID');
        } finally {
            reader.releaseLock();
        }
    }

    function safeKeyboard(markup) {
        return markup && Object.keys(markup).join(',') === 'inline_keyboard' && Array.isArray(markup.inline_keyboard) && markup.inline_keyboard.length <= 15 && markup.inline_keyboard.every(row => Array.isArray(row) && row.length > 0 && row.length <= 3 && row.every(item => item && Object.keys(item).sort().join(',') === 'callback_data,text' && typeof item.text === 'string' && item.text.length > 0 && item.text.length <= 64 && typeof item.callback_data === 'string' && /^[A-Za-z0-9_:-]{1,64}$/.test(item.callback_data)));
    }

    return {
        downloadVoice: async (fileId, maximum = 1048576) => {
            if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(fileId) || !Number.isSafeInteger(maximum) || maximum < 16 || maximum > 2097152) throw new TelegramError('VOICE_REJECTED');
            const file = await call('getFile', { file_id: fileId });
            if (!Number.isSafeInteger(file?.file_size) || file.file_size > maximum || typeof file.file_path !== 'string' || !/^voice\/[A-Za-z0-9_-]+\.(?:oga|ogg)$/.test(file.file_path)) throw new TelegramError('VOICE_REJECTED');
            let response;
            try { response = await fetchImpl(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }); }
            catch { throw new TelegramError('VOICE_UNAVAILABLE'); }
            if (!response.ok || Number(response.headers.get('content-length')) > maximum || !response.body) { await response.body?.cancel(); throw new TelegramError('VOICE_REJECTED'); }
            const chunks = []; let length = 0;
            try {
                for await (const chunk of response.body) { length += chunk.length; if (length > maximum) throw new Error(); chunks.push(chunk); }
            } catch { throw new TelegramError('VOICE_REJECTED'); }
            return Buffer.concat(chunks);
        },
        getMe: () => call('getMe', {}),
        getWebhookInfo: () => call('getWebhookInfo', {}),
        getUpdates: async offset => {
            if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0))
                throw new TelegramError('INVALID_OFFSET');
            const payload = { timeout: 5, limit: 20 };
            if (offset !== undefined) payload.offset = offset;
            const updates = await call('getUpdates', payload);
            if (!Array.isArray(updates) || updates.length > 20 || updates.some(update => !Number.isSafeInteger(update?.update_id) || update.update_id < 0))
                throw new TelegramError('TELEGRAM_RESPONSE_INVALID');
            return updates;
        },
        sendReply: async payload => {
            const fields = enableButtons ? ['chat_id', 'text', 'protect_content', 'parse_mode', 'reply_markup'] : ['chat_id', 'text', 'protect_content'];
            if (!payload || payload.chat_id !== allowedUserId || payload.protect_content !== true || typeof payload.text !== 'string' || payload.text.length < 1 || payload.text.length > 4096 || Object.keys(payload).some(key => !fields.includes(key)) || (payload.parse_mode !== undefined && payload.parse_mode !== 'HTML') || (payload.reply_markup !== undefined && !safeKeyboard(payload.reply_markup)))
                throw new TelegramError('REPLY_BLOCKED');
            return call('sendMessage', { ...payload, chat_id: allowedUserId, protect_content: true, link_preview_options: { is_disabled: true } });
        },
        ...(enableButtons ? { editReply: async payload => {
            const fields = ['chat_id', 'message_id', 'text', 'protect_content', 'parse_mode', 'reply_markup'];
            if (!payload || payload.chat_id !== allowedUserId || payload.protect_content !== true || !Number.isSafeInteger(payload.message_id) || payload.message_id <= 0 || typeof payload.text !== 'string' || payload.text.length < 1 || payload.text.length > 4096 || Object.keys(payload).some(key => !fields.includes(key)) || (payload.parse_mode !== undefined && payload.parse_mode !== 'HTML') || (payload.reply_markup !== undefined && !safeKeyboard(payload.reply_markup))) throw new TelegramError('REPLY_BLOCKED');
            const { protect_content, ...body } = payload;
            try { return await call('editMessageText', { ...body, link_preview_options: { is_disabled: true } }); }
            catch (error) { if (error?.code !== 'EDIT_NOT_MODIFIED') throw error; }
        }, answerCallback: async (id, text) => {
            if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || (text !== undefined && (typeof text !== 'string' || text.length > 200))) throw new TelegramError('CALLBACK_BLOCKED');
            await call('answerCallbackQuery', { callback_query_id: id, ...(text === undefined ? {} : { text }) });
        } } : {}),
    };
}
