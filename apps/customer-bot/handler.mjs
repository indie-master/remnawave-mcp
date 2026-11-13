export const customerKeyboard = { inline_keyboard: [[{ text: '👤 Мой аккаунт', callback_data: 'customer_account' }, { text: '💬 Поддержка', callback_data: 'customer_support' }], [{ text: '🗂 Переписка', callback_data: 'customer_history' }, { text: '🏠 Меню', callback_data: 'customer_home' }]] };
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (value, divisor) => Number.isSafeInteger(value) ? (value / divisor).toLocaleString('ru-RU', { maximumFractionDigits: divisor === 100 ? 2 : 6 }) : 'недоступно';
const excerpt = value => { let output = ''; for (const c of String(value).slice(0, 300)) { const item = escape(c); if (output.length + item.length > 350) return output + '…'; output += item; } return output; };

export function createCustomerHandler({ call, send, edit, answerCallback, botId, miniAppUrl, now = Date.now }) {
    const attempts = new Map();
    let keyboard = customerKeyboard;
    if (miniAppUrl) {
        const url = new URL(miniAppUrl);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/miniapp') throw new Error('INVALID_MINI_APP_URL');
        keyboard = { inline_keyboard: [[{ text: '📱 Личный кабинет', web_app: { url: url.href } }], ...customerKeyboard.inline_keyboard] };
    }
    return async update => {
        const callback = update?.callback_query; const message = callback?.message ?? update?.message; const from = callback?.from ?? message?.from;
        if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0 || !message || message.chat?.type !== 'private' || !Number.isSafeInteger(from?.id) || from.id <= 0 || from.is_bot !== false || from.id !== message.chat.id || message.forward_origin || message.forward_from || message.forward_from_chat) return;
        if (callback && (message.from?.id !== botId || message.from.is_bot !== true || !Number.isSafeInteger(message.message_id) || message.message_id <= 0 || typeof callback.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(callback.id))) return;
        if (!callback && (!Number.isSafeInteger(message.date) || now() / 1000 - message.date > 120 || now() / 1000 - message.date < -15 || typeof message.text !== 'string' || message.text.length > 2000)) return;
        const id = from.id;
        if (callback) { try { await answerCallback(callback.id); } catch {} }
        const previous = attempts.get(id); let count = previous && now() >= previous.at && now() - previous.at < 60000 ? previous.count + 1 : 1;
        while (attempts.size >= 1000) attempts.delete(attempts.keys().next().value);
        attempts.set(id, { at: count === 1 ? now() : previous.at, count });
        if (count > 12) return;
        const reply = async (text, markup = keyboard) => {
            if (callback && edit) { try { return await edit(id, message.message_id, text, markup); } catch (error) { if (error?.code !== 'EDIT_UNAVAILABLE') throw error; } }
            return send(id, text, markup);
        };
        const text = callback ? '' : message.text.trim();
        const action = callback?.data;
        try {
            const start = text.match(/^\/start\s+([A-Za-z0-9_-]{32})$/);
            if (start) { await call('/link', { telegramId: id, code: start[1] }); await reply('✅ Аккаунт привязан. Здесь доступны ваши сведения и переписка с поддержкой.'); return; }
            if (text.startsWith('/start ') || (action && !['customer_home', 'customer_account', 'customer_history', 'customer_support'].includes(action))) { await reply('Используйте кнопки меню. Для привязки откройте новую ссылку из своего кабинета.'); return; }
            if (text === '/start') {
                await call('/bootstrap', { telegramId: id, firstName: typeof from.first_name === 'string' ? from.first_name : '', lastName: typeof from.last_name === 'string' ? from.last_name : '' });
                await reply('Добро пожаловать! Ваш аккаунт готов. Здесь можно проверить подписку и написать поддержке.' + (miniAppUrl ? ' Откройте «Личный кабинет», чтобы подключить почту или существующий аккаунт.' : ' Личный кабинет будет доступен после подключения защищённого адреса.')); return;
            }
            if (action === 'customer_account') {
                const value = await call('/account', { telegramId: id });
                const subscription = value.subscription;
                const state = subscription && ['ACTIVE', 'DISABLED', 'EXPIRED', 'LIMITED'].includes(subscription.status) && typeof subscription.expireAt === 'string' && Number.isFinite(Date.parse(subscription.expireAt)) ? `\nСтатус: ${escape(subscription.status)}\nДо: ${escape(new Date(subscription.expireAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }))} МСК\nПроверено: ${escape(String(subscription.observedAt ?? '').slice(0, 40))}` : '\nСведения о подписке сейчас недоступны.';
                await reply(`<b>Ваш аккаунт</b>${value.profileName ? '\n' + escape(value.profileName) : ''}\nБаланс RUB: ${money(value.balances?.RUB, 100)}\nБаланс USDT: ${money(value.balances?.USDT, 1000000)}${value.panelLinked === false ? '\nПодписка ещё не подключена. Обратитесь в поддержку.' : state}`); return;
            }
            if (action === 'customer_history') {
                const value = await call('/history', { telegramId: id });
                if (!Array.isArray(value.history)) throw new Error('CUSTOMER_UNAVAILABLE');
                await reply('<b>Ваша переписка</b>\n\n' + (value.history.slice(-6).map(item => `<b>${item.role === 'user' ? 'Вы' : 'Поддержка'}:</b> ${excerpt(item.text)}`).join('\n\n') || 'Пока нет сообщений.')); return;
            }
            if (action === 'customer_support' || action === 'customer_home' || ['/start', '/menu', '/help', '/cancel'].includes(text)) {
                await call('/history', { telegramId: id });
                await reply(action === 'customer_support' ? '💬 Напишите сообщение поддержке обычным текстом. Можно отправлять уточнения подряд; ответы администратора появятся здесь и в кабинете.' : 'Выберите раздел. Обычный текст отправляется в вашу переписку с поддержкой.'); return;
            }
            if (text.startsWith('/')) { await reply('Используйте кнопки меню. Административные команды здесь недоступны.'); return; }
            if (!text || text.length > 500) { await reply('Отправьте текстовое сообщение до 500 символов.'); return; }
            const result = await call('/question', { telegramId: id, key: `tg_${id}_${update.update_id}`, text });
            if (typeof result.reply === 'string' && result.reply) await reply(escape(result.reply.slice(0, 500)), null);
        } catch (error) {
            if (error?.code) throw error;
            const messages = { CUSTOMER_NOT_LINKED: 'Сначала войдите в свой кабинет и нажмите «Подключить Telegram». Пароль в Telegram присылать не нужно.', CUSTOMER_LINK_REJECTED: 'Ссылка недействительна, истекла или аккаунт уже привязан. Создайте новую ссылку в своём кабинете.', CUSTOMER_RATE_LIMIT: 'Слишком много сообщений. Подождите минуту.', INVALID_MESSAGE: 'Отправьте текст до 500 символов.' };
            await reply(messages[error?.message] ?? 'Запрос сейчас недоступен. Перед повтором проверьте переписку: сообщение могло сохраниться.');
        }
    };
}
