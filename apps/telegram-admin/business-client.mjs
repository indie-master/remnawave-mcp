import { request } from 'node:http';
import { randomBytes } from 'node:crypto';

export function createBusinessClient({ requestImpl = request } = {}) {
    return (path, value) => new Promise((resolve, reject) => {
        if (!['/pending', '/approve', '/reject', '/support-reply', '/renewal-reserve', '/renewal-settle', '/media-approve', '/recovery', '/billing-history', '/renewal-reconcile'].includes(path) && !/^\/(?:support|media|recovery)\/[a-f0-9]{24}$/.test(path)) { reject(new Error('BUSINESS_UNAVAILABLE')); return; }
        const call = requestImpl({ socketPath: '/business-bridge/admin.sock', method: value === undefined ? 'GET' : 'POST', path, headers: { 'Content-Type': 'application/json' }, timeout: path === '/media-approve' ? 55000 : 5000 }, response => {
            let body = ''; response.on('data', chunk => { body += chunk; if (body.length > 16384) response.destroy(); });
            response.on('error', () => reject(new Error('BUSINESS_UNAVAILABLE')));
            response.on('end', () => { try { if (response.statusCode !== 200) throw new Error(); resolve(JSON.parse(body)); } catch { reject(new Error('BUSINESS_UNAVAILABLE')); } });
        }); call.on('error', () => reject(new Error('BUSINESS_UNAVAILABLE'))); call.on('timeout', () => call.destroy()); call.end(value === undefined ? undefined : JSON.stringify(value));
    });
}

export function createBusinessAdmin({ actorId, administration, call = createBusinessClient(), now = Date.now }) {
    if (!Number.isSafeInteger(actorId) || actorId <= 0) throw new Error('INVALID_ADMIN_ID');
    const previews = new Map();
    const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    const reply = (text, rows = [[{ text: '🏠 Меню', callback_data: 'home' }]]) => ({ text, reply_markup: { inline_keyboard: rows } });
    return async ({ text, data, allowedUserId }) => {
        if (allowedUserId !== actorId) return null;
        const supportReply = text?.match(/^ответ\s+([a-f0-9]{24})\s+([\s\S]{1,1000})$/i);
        const paymentReference = text?.match(/^плат[её]ж\s+([a-f0-9]{24})\s+([A-Za-z][A-Za-z0-9_-]{1,19}:[A-Za-z0-9:_-]{4,100})$/i);
        const reconciliation = text?.match(/^сверка\s+([a-f0-9]{24})\s+(выполнено|возврат)\s+([^\r\n]{8,200})$/i);
        if (/^(?:плат[её]ж|ответ|сверка)(?:\s|$)/i.test(text ?? '') && !paymentReference && !supportReply && !reconciliation) return reply('Формат: «платеж ID система:ID-операции», «ответ ID текст» или «сверка ID выполнено|возврат основание проверки». Запрос к ИИ не выполнялся.');
        if (!supportReply && !paymentReference && !reconciliation && !['оплаты', '/payments', 'поддержка'].includes(text) && !/^(?:business_home|business_support|business_renewals|business_recovery|business_history|bv:[a-f0-9]{24}|rv:[A-Za-z0-9_-]{16}|bm:[a-f0-9]{24}|mc:[A-Za-z0-9_-]{16}|br:[a-f0-9]{24}|rc:[A-Za-z0-9_-]{16}|bh:[a-f0-9]{24}|bp:[a-f0-9]{24}|bc:[A-Za-z0-9_-]{16}|bx:[A-Za-z0-9_-]{16})$/.test(data ?? '')) return null;
        try {
            if (data === 'business_recovery') {
                const result = await call('/recovery');
                if (!Array.isArray(result.cases)) throw new Error();
                return reply('<b>Продления на ручной сверке</b>\nАвтоматического повтора PATCH и возврата нет. Сначала проверьте панель и журналы.', [...result.cases.filter(value => /^[a-f0-9]{24}$/.test(value.id) && Number.isSafeInteger(value.panel_id)).slice(0, 10).map(value => [{ text: `#${value.panel_id} · ${value.state}`, callback_data: `bv:${value.id}` }]), [{ text: 'История операций', callback_data: 'business_history' }], [{ text: 'Назад', callback_data: 'business_home' }]]);
            }
            if (data === 'business_history') {
                const result = await call('/billing-history');
                if (!Array.isArray(result.entries)) throw new Error();
                return reply('<b>История биллинга</b>\n' + result.entries.slice(0, 10).map(entry => `${escape(entry.operation)} · ${escape(entry.state)}\n<code>${escape(entry.subject)}</code>\n${escape(new Date(entry.created).toISOString())}${entry.note ? '\n' + escape(String(entry.note).slice(0, 200)) : ''}`).join('\n\n'), [[{ text: 'Назад', callback_data: 'business_home' }]]);
            }
            if (data?.startsWith('bv:') || reconciliation) {
                const id = reconciliation?.[1] ?? data.slice(3);
                const item = await call('/recovery/' + id);
                if (item.id !== id || !Number.isSafeInteger(item.panel_id) || !Number.isSafeInteger(item.readyAt) || !['executing', 'uncertain'].includes(item.state) || !/^[A-Za-z0-9_-]{16}$/.test(item.proposal)) throw new Error();
                if (!reconciliation) return reply(`<b>Сверка продления #${item.panel_id}</b>\nID: <code>${id}</code>\nСостояние: ${escape(item.state)}\nРезерв: ${escape(item.units)} минимальных единиц ${escape(item.currency)}\nСверка доступна после: ${escape(new Date(item.readyAt).toISOString())}\n\nПроверьте панель и журналы: нет ли запроса, который ещё выполняется. Затем напишите:\n<code>сверка ${id} выполнено основание</code>\nили\n<code>сверка ${id} возврат основание</code>\nНужна отдельная кнопка подтверждения. Эти действия меняют только учёт баланса, не панель.`, [...(administration ? [[{ text: 'Проверить карточку', callback_data: `au:${item.panel_id}` }]] : []), [{ text: 'Назад', callback_data: 'business_recovery' }]]);
                if (now() < item.readyAt) return reply('Защитная задержка сверки ещё не истекла. Средства остаются в резерве; панель не изменяется.');
                const outcome = reconciliation[2].toLowerCase() === 'возврат' ? 'refunded' : 'done';
                if (administration?.hasInFlight?.(actorId)) return reply('Административный запрос ещё выполняется. Сверка и возврат пока запрещены.');
                if (outcome === 'refunded' && !administration) return reply('Для возврата нужно отдельно включить административные карточки и проверить результат исходной операции.');
                if (outcome === 'refunded' && administration?.receipt(actorId, item.proposal) === 'done') return reply('Панель уже подтвердила операцию. Возврат этого резерва запрещён; сначала сверяйте историю и фактическую подписку.');
                while (previews.size >= 20) previews.delete(previews.keys().next().value);
                const key = randomBytes(12).toString('base64url');
                previews.set(key, { reconciliation: true, id, state: item.state, proposal: item.proposal, outcome, note: reconciliation[3], at: now() });
                return reply(`<b>Ручная сверка #${item.panel_id}</b>\n${outcome === 'done' ? 'Зафиксировать выполненное продление; резерв остаётся списанным.' : 'Вернуть резерв на баланс один раз. Продление повторно не отправляется.'}\nОснование: ${escape(reconciliation[3])}\n\nПодтверждайте только после проверки панели и журналов: незавершённых запросов быть не должно. Это не повтор API-операции и не автоматическое доказательство её результата.`, [[{ text: '✅ Сверено вручную', callback_data: `rv:${key}` }, { text: 'Отмена', callback_data: `bx:${key}` }]]);
            }
            if (data?.startsWith('rv:')) {
                const value = previews.get(data.slice(3)); previews.delete(data.slice(3));
                if (!value?.reconciliation || now() < value.at || now() - value.at >= 180000) return reply('Подтверждение сверки устарело или использовано.');
                if (administration?.hasInFlight?.(actorId) || (value.outcome === 'refunded' && !administration)) return reply('Сверка сейчас запрещена: проверьте административный модуль и незавершённые запросы.');
                if (value.outcome === 'refunded' && administration?.receipt(actorId, value.proposal) === 'done') return reply('Панель подтвердила операцию. Возврат резерва запрещён.');
                const settled = await call('/renewal-reconcile', { id: value.id, state: value.state, proposal: value.proposal, outcome: value.outcome, note: value.note });
                if (settled?.settled !== true || settled.outcome !== value.outcome) throw new Error();
                return reply('✅ Сверка зафиксирована в журнале. ' + (value.outcome === 'done' ? 'Продление отмечено выполненным.' : 'Резерв возвращён на баланс один раз.') + ' Запрос к панели не отправлялся.');
            }
            if (supportReply) { await call('/support-reply', { id: supportReply[1], text: supportReply[2] }); return reply('Ответ сохранён в истории кабинета клиента. В Telegram клиенту ничего не отправлялось.'); }
            if (data?.startsWith('bh:')) {
                const thread = await call('/support/' + data.slice(3));
                if (!Array.isArray(thread.history)) throw new Error();
                return reply(`<b>Обращение ${escape(thread.id)}</b>\n${thread.history.slice(-6).map(item => `${item.role === 'user' ? 'Клиент' : 'Поддержка'}: ${escape(String(item.text).slice(0, 300))}`).join('\n\n')}\n\nОтветить: <code>ответ ${escape(thread.id)} текст ответа</code>`, [...(thread.media ?? []).filter(item => /^[a-f0-9]{24}$/.test(item.id)).slice(0, 5).map(item => [{ text: '📷 Проверить текст вложения', callback_data: `bm:${item.id}` }]), [{ text: '🏠 Меню', callback_data: 'home' }]]);
            }
            if (data?.startsWith('bm:')) {
                const media = await call('/media/' + data.slice(3));
                const key = randomBytes(12).toString('base64url');
                while (previews.size > 20) previews.delete(previews.keys().next().value);
                previews.set(key, { media: true, id: data.slice(3), at: now() });
                return reply(`<b>Текст вложения — пока не передан ИИ</b>\n${escape(String(media.text).slice(0, 500))}\n\nПроверьте отсутствие секретов. Если они есть, не подтверждайте; ответьте клиенту вручную. Подтверждение разрешит передать только этот текст и историю этого клиента модели в пределах общего бюджета.`, [[{ text: '✅ Текст безопасен, разрешить ИИ', callback_data: `mc:${key}` }, { text: 'Отмена', callback_data: `bx:${key}` }]]);
            }
            if (data?.startsWith('mc:')) {
                const media = previews.get(data.slice(3)); previews.delete(data.slice(3));
                if (!media?.media || now() - media.at > 180000) return reply('Подтверждение устарело.');
                const result = await call('/media-approve', { id: media.id });
                return reply(escape(result.reply ?? 'Текст проверен. Ответ доступен в истории клиента.'));
            }
            if (data?.startsWith('bx:')) { previews.delete(data.slice(3)); return reply('Подтверждение отменено; новых операций не отправлялось.'); }
            if (data?.startsWith('bc:')) {
                const value = previews.get(data.slice(3)); previews.delete(data.slice(3));
                if (!value || now() - value.at > 180000) return reply('Подтверждение устарело.');
                await call('/approve', { id: value.id, reference: value.reference });
                return reply('✅ Ручное поступление подтверждено, баланс зачислен один раз. Подписка автоматически не менялась.');
            }
            if (data?.startsWith('rc:')) {
                const preview = previews.get(data.slice(3)); previews.delete(data.slice(3));
                if (!preview?.renewal || !administration || now() - preview.at > 180000) return reply('Подтверждение устарело.');
                await call('/renewal-reserve', { id: preview.id, proposal: preview.proposal });
                let outcome;
                try { await administration.confirm(actorId, preview.proposal); outcome = 'done'; }
                catch {
                    try { administration.cancel(actorId, preview.proposal); } catch {}
                    outcome = ['rejected', 'cancelled'].includes(administration.receipt(actorId, preview.proposal)) ? 'rejected' : 'uncertain';
                }
                await call('/renewal-settle', { id: preview.id, outcome });
                return reply(outcome === 'done' ? '✅ Подписка продлена, стоимость списана с баланса один раз.' : outcome === 'rejected' ? 'Панель не изменена. Резерв баланса возвращён; создайте новую заявку.' : 'Результат изменения неясен. Средства удержаны до ручной сверки; повторного запроса и автоматического возврата нет.');
            }
            const pending = await call('/pending');
            if (!Array.isArray(pending.payments) || !Array.isArray(pending.renewals)) throw new Error();
            if (data?.startsWith('br:')) {
                if (!administration) return reply('Для продления включите отдельно карточки и подтверждаемые изменения пользователей. Баланс не списан.');
                const renewal = pending.renewals.find(value => value.id === data.slice(3));
                if (!renewal || !Number.isSafeInteger(renewal.panel_id) || !Number.isInteger(renewal.days) || renewal.days < 1 || renewal.days > 366 || !['RUB', 'USDT'].includes(renewal.currency) || !Number.isSafeInteger(renewal.units)) throw new Error();
                const proposal = await administration.prepareRenewal(actorId, String(renewal.panel_id), renewal.days);
                const expireAt = proposal.changes.expireAt;
                const key = randomBytes(12).toString('base64url');
                while (previews.size > 20) previews.delete(previews.keys().next().value);
                previews.set(key, { renewal: true, id: renewal.id, proposal: proposal.id, at: now() });
                return reply(`<b>Продление пользователя #${renewal.panel_id}</b>\nНовый срок: ${expireAt}\nС баланса: ${renewal.units / (renewal.currency === 'RUB' ? 100 : 1000000)} ${renewal.currency}\nБудут проверены текущие данные и остаток. При неопределённом результате повтор запрещён до ручной сверки.`, [[{ text: '✅ Продлить и списать', callback_data: `rc:${key}` }, { text: 'Отмена', callback_data: `bx:${key}` }]]);
            }
            if (data === 'business_renewals') return reply('<b>Заявки продления</b>\nСтоимость и срок фиксируются при создании заявки, окончательное изменение — только после подтверждения.', [...pending.renewals.filter(value => /^[a-f0-9]{24}$/.test(value.id) && Number.isSafeInteger(value.panel_id)).slice(0, 10).map(value => [{ text: `Продлить #${value.panel_id}`, callback_data: `br:${value.id}` }]), [{ text: '🏠 Меню', callback_data: 'home' }]]);
            if (data === 'business_support' || text === 'поддержка') {
                const tickets = (pending.support ?? []).filter(value => /^[a-f0-9]{24}$/.test(value.id) && Number.isSafeInteger(value.panel_id));
                return reply(`<b>Поддержка: ${tickets.length}</b>\nПоказаны первые 10 обращений.`, [...tickets.slice(0, 10).map(value => [{ text: `Пользователь #${value.panel_id}`, callback_data: `bh:${value.id}` }]), [{ text: '🏠 Меню', callback_data: 'home' }]]);
            }
            if (data?.startsWith('bp:') || paymentReference) {
                const payment = pending.payments.find(value => value.id === (paymentReference?.[1] ?? data.slice(3)));
                if (!payment || !['RUB', 'USDT'].includes(payment.currency) || !Number.isSafeInteger(payment.units)) throw new Error();
                while (previews.size > 20) previews.delete(previews.keys().next().value);
                if (!paymentReference) return reply(`<b>Платёж ${payment.id}</b>\nСначала проверьте поступление и запишите уникальный ID операции: <code>платеж ${payment.id} система:ID-операции</code>\nСкриншот клиента не доказывает поступление. Одна операция не сможет зачислить два платежа.`);
                const key = randomBytes(12).toString('base64url'); previews.set(key, { id: payment.id, reference: paymentReference[2], at: now() });
                return reply(`<b>Ручная проверка платежа</b>\nID: ${payment.id}\nПользователь: #${payment.panel_id ?? 'не указан'}\nОперация: ${escape(paymentReference[2])}\nСумма: ${payment.units / (payment.currency === 'RUB' ? 100 : 1000000)} ${payment.currency}\nПроверьте поступление в своей платёжной системе. Кнопка зачислит баланс, но не продлит подписку.`, [[{ text: '✅ Поступление проверено', callback_data: `bc:${key}` }, { text: 'Отмена', callback_data: `bx:${key}` }]]);
            }
            const payments = pending.payments.filter(value => /^[a-f0-9]{24}$/.test(value.id) && ['RUB', 'USDT'].includes(value.currency) && Number.isSafeInteger(value.units));
            const renewals = pending.renewals.filter(value => /^[a-f0-9]{24}$/.test(value.id) && Number.isSafeInteger(value.panel_id));
            return reply(`<b>Оплаты: ${payments.length}</b>\nПоказаны кнопки первых 10; после подтверждения обновите список.\nПодтверждение только после проверки поступления.\n\n<b>Заявки продления: ${renewals.length}</b>\nПродление и списание требуют отдельного подтверждения.`, [...payments.slice(0, 10).map(value => [{ text: `${value.currency} ${value.units / (value.currency === 'RUB' ? 100 : 1000000)} · ${value.id.slice(0, 6)}`, callback_data: `bp:${value.id}` }]), [{ text: '⏳ Продления', callback_data: 'business_renewals' }], ...(pending.features?.reconciliation === true ? [[{ text: '🔎 Ручная сверка', callback_data: 'business_recovery' }, { text: '🗒 Журнал', callback_data: 'business_history' }]] : []), [{ text: '🛟 Обращения поддержки', callback_data: 'business_support' }], [{ text: '🏠 Меню', callback_data: 'home' }]]);
        } catch { return reply('Бизнес-модуль недоступен. Подтверждение оплаты не повторяется автоматически.'); }
    };
}
