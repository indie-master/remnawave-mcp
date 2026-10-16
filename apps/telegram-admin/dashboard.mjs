import { randomBytes } from 'node:crypto';
import { expiryWindows } from './panel-service.mjs';
import { reportActions, validateIntent } from './intent.mjs';
import { resolveLocalRequest } from './local-router.mjs';
import { extraView } from './extra-views.mjs';

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const button = (text, callback_data) => ({ text, callback_data });
const keyboard = rows => ({ inline_keyboard: rows });
const time = value => new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
const menu = keyboard([
    [button('📊 Статистика', 'q:stats'), button('🖥 Ноды', 'q:nodes')],
    [button('⏳ Подписки', 'periods'), button('ℹ️ Версия', 'q:version')],
    [button('🧠 Лимит ИИ', 'budget')],
]);
const extendedMenu = keyboard([
    [button('📊 Статистика', 'q:stats'), button('🖥 Ноды', 'q:nodes')],
    [button('👥 Пользователи', 'q:users'), button('🟢 Онлайн', 'q:online')],
    [button('⏳ Подписки', 'periods'), button('📋 Список нод', 'q:node_details')],
    [button('⚙️ Ресурсы', 'q:system'), button('📈 Трафик', 'q:bandwidth')],
    [button('🗂 Конфигурация', 'configuration'), button('🩺 Процессы', 'q:health')],
    [button('ℹ️ Версия', 'q:version'), button('🧠 Лимит ИИ', 'budget')],
]);

export function createDashboard({ allowedUserId, service, classify, mcpRead, budgetStatus, textModeDescription, enhancedUi = false, answerCallback = async () => {}, onDiagnostic = () => {}, now = Date.now, nonce = () => randomBytes(9).toString('base64url') }) {
    if (!Number.isSafeInteger(allowedUserId) || allowedUserId <= 0) throw new Error('INVALID_ADMIN_ID');
    const reports = new Map();
    const drafts = new Map();
    let lastUpdateId = -1;
    let lastRead = -Infinity;
    let busy = false;
    let context;
    const reply = (text, reply_markup = enhancedUi ? extendedMenu : menu) => ({ chat_id: allowedUserId, text, protect_content: true, parse_mode: 'HTML', reply_markup });
    function clarification(topic) {
        const rows = topic === 'period'
            ? [[1, 3, 7].map(days => button(`${days} дн.`, `q:expiring:${days}`)), [14, 30].map(days => button(`${days} дн.`, `q:expiring:${days}`))]
            : topic === 'squads'
                ? [[button('Внутренние', 'q:internal_squads'), button('Внешние', 'q:external_squads')]]
                : [[button('👥 Пользователи', 'q:users'), button('🟢 Онлайн', 'q:online')], [button('📊 Общая статистика', 'q:stats'), button('🖥 Ноды', 'q:nodes')], [button('⏳ Подписки', 'periods')]];
        return reply(topic === 'period' ? 'Выберите поддерживаемый период: только активные подписки, истекающие от текущего момента. Даты и другие фильтры автоматически не подменяются.' : 'Уточните раздел. Запрос к ИИ не выполнялся; дополнительные фильтры не применены.', keyboard([...rows, [button('🏠 Меню', 'home')]]));
    }
    function nodePage(key, page = 0) {
        const report = snapshot(key);
        const lines = extraView('node_details', report, page);
        const navigation = [];
        if (page > 0) navigation.push(button('←', `nodepage:${key}:${page - 1}`));
        if ((page + 1) * 5 < report.nodes.length) navigation.push(button('→', `nodepage:${key}:${page + 1}`));
        lines.push(`\nПроверено: ${time(report.observedAt)} МСК`);
        return reply(lines.join('\n'), keyboard([...(navigation.length ? [navigation] : []), [button('🔄 Обновить', 'q:node_details'), button('🏠 Меню', 'home')]]));
    }

    function snapshot(key) {
        const stored = reports.get(key);
        if (!stored || now() - stored.savedAt > 600000) throw new Error('REPORT_EXPIRED');
        return stored.report;
    }
    function store(report) {
        while (reports.size >= 10) reports.delete(reports.keys().next().value);
        const key = nonce();
        if (!/^[A-Za-z0-9_-]{8,24}$/.test(key)) throw new Error('INVALID_SNAPSHOT_KEY');
        reports.set(key, { report, savedAt: now() });
        return key;
    }
    function expiryPage(key, page = 0) {
        const report = snapshot(key);
        const pages = Math.max(1, Math.ceil(report.users.length / 5));
        if (!Number.isSafeInteger(page) || page < 0 || page >= pages) throw new Error('INVALID_PAGE');
        const users = report.users.slice(page * 5, page * 5 + 5);
        const lines = [`<b>⏳ Подписки: ближайшие ${report.days} дн.</b>`, `Найдено: <b>${report.count}</b> · страница ${page + 1}/${pages}`];
        if (!report.complete) lines.push(`⚠️ Частичный отчёт: проверено ${report.scanned} из ${report.total}.`);
        if (!users.length) lines.push('В проверенной части списка подходящих подписок нет.');
        for (const user of users) {
            const name = service.ownerName?.(user.id) ?? user.username;
            lines.push(`\n<b>${escapeHtml(name)}</b> · ID ${user.id}`, `Окончание: ${time(user.expireAt)} МСК · осталось ${user.hoursRemaining} ч.`, `Трафик: ${user.trafficUsedBytes === null ? 'нет данных' : (user.trafficUsedBytes / 1073741824).toFixed(2) + ' ГБ'} / ${user.trafficLimitBytes === 0 ? 'без лимита' : user.trafficLimitBytes === null ? 'нет данных' : (user.trafficLimitBytes / 1073741824).toFixed(2) + ' ГБ'}`, `Telegram: ${user.telegramLinked ? 'привязан; возможность доставки не проверена' : 'не привязан'}`);
        }
        lines.push(`\nПроверено: ${time(report.observedAt)} МСК.\nУведомления клиентам <b>не отправляются</b>.`);
        const rows = users.map((user, index) => [button(`📝 Черновик для #${user.id}`, `draft:${key}:${page * 5 + index}`)]);
        const navigation = [];
        if (page > 0) navigation.push(button('←', `page:${key}:${page - 1}`));
        if (page + 1 < pages) navigation.push(button('→', `page:${key}:${page + 1}`));
        if (navigation.length) rows.push(navigation);
        rows.push([button('🔄 Проверить заново', `q:expiring:${report.days}`), button('🏠 Меню', 'home')]);
        return reply(lines.join('\n'), keyboard(rows));
    }
    function render(action, report) {
        if (action === 'expiring') return expiryPage(store(report));
        if (action === 'node_details') return nodePage(store(report));
        const lines = extraView(action, report) ?? (action === 'stats'
            ? ['<b>📊 Статистика</b>', `Всего пользователей: <b>${report.totalUsers}</b>`, `Онлайн: <b>${report.usersOnline}</b>`]
            : action === 'nodes'
                ? ['<b>🖥 Состояние нод</b>', `Всего: ${report.nodesTotal}`, `🟢 Онлайн: ${report.nodesOnline}`, `🔴 Офлайн: ${report.nodesOffline}`, `⚪ Отключены: ${report.nodesDisabled}`, `🟡 Подключаются: ${report.nodesConnecting}`]
                : ['<b>ℹ️ Версия панели</b>', escapeHtml(report.panelVersion)]);
        lines.push(`\nПроверено: ${time(report.observedAt)} МСК`);
        return reply(lines.join('\n'), keyboard([[button('🔄 Проверить заново', `q:${action}`), button('🏠 Меню', 'home')]]));
    }

    return async update => {
        const callback = update?.callback_query;
        const message = callback?.message ?? update?.message;
        const from = callback?.from ?? message?.from;
        if (!message || message.chat?.type !== 'private' || message.chat.id !== allowedUserId || from?.id !== allowedUserId || from.is_bot !== false)
            return null;
        if (!Number.isSafeInteger(update.update_id) || update.update_id <= lastUpdateId || update.update_id < 0) return null;
        lastUpdateId = update.update_id;
        if (callback) {
            if (typeof callback.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(callback.id) || typeof callback.data !== 'string' || callback.data.length > 64) return null;
            try { await answerCallback(callback.id); }
            catch (error) {
                if (!['NETWORK_FAILED', 'CALLBACK_EXPIRED'].includes(error?.code)) throw error;
                onDiagnostic({ event: 'callback', ok: false, code: 'ACK_UNAVAILABLE' });
            }
        } else {
            const age = now() / 1000 - message.date;
            if (!Number.isSafeInteger(message.date) || age > 120 || age < -15 || message.forward_origin || message.forward_from || message.forward_from_chat || typeof message.text !== 'string' || message.text.length > 2000)
                return null;
        }
        try {
            const data = callback?.data;
            const text = callback ? '' : message.text.trim();
            if (data === 'home' || ['/start', '/help', '/menu'].includes(text)) return reply('<b>Панель управления</b>\nКнопки — без ИИ. ' + (textModeDescription ?? (classify && mcpRead ? 'Текстовый вопрос — через Codex и MCP.' : 'ИИ в этом запуске отключён; используйте кнопки.')) + '\nУведомления: только черновики администратору.');
            if (data === 'budget' || text === '/budget') {
                if (!budgetStatus) return reply('Учёт ИИ недоступен. Кнопки работают без ИИ.');
                const budget = budgetStatus();
                return reply(`<b>🧠 Лимит ИИ</b>\nСутки: ${escapeHtml(budget.day)} МСК\nПопыток: ${budget.used}/${budget.limit}\nОсталось: ${budget.remaining}\nСохранённых команд: ${budget.cacheEntries}\n\nКнопки, локальные команды и повторения из кеша не расходуют лимит. Ошибки ИИ учитываются. Это счётчик вызовов нашего бота, не остаток подписки ChatGPT.`);
            }
            if (data === 'periods' || text === '/expiring') return reply('За какой период проверить подписки?', keyboard([
                ...[[1, 3, 7], [14, 30]].map(days => days.map(day => button(`${day} дн.`, `q:expiring:${day}`))),
                [button('🏠 Меню', 'home')],
            ]));
            if (data === 'configuration') return reply('<b>🗂 Конфигурация: проверки чтения</b>\nПоказываются только счётчики. Ключи и содержимое конфигураций скрыты.', keyboard([
                [button('🌐 Хосты', 'q:hosts'), button('🗂 Профили', 'q:profiles')],
                [button('🔹 Внутренние сквады', 'q:internal_squads')],
                [button('🔸 Внешние сквады', 'q:external_squads')],
                [button('🏠 Меню', 'home')],
            ]));
            const nodeNavigation = data?.match(/^nodepage:([A-Za-z0-9_-]{8,24}):(\d+)$/);
            if (nodeNavigation) return nodePage(nodeNavigation[1], Number(nodeNavigation[2]));
            const saved = data?.match(/^(page|draft):([A-Za-z0-9_-]{8,24}):(\d+)$/);
            if (saved) {
                if (saved[1] === 'page') return expiryPage(saved[2], Number(saved[3]));
                const report = snapshot(saved[2]);
                const user = report.users[Number(saved[3])];
                if (!user) throw new Error('INVALID_PAGE');
                while (drafts.size >= 50) drafts.delete(drafts.keys().next().value);
                const key = nonce();
                drafts.set(key, { savedAt: now(), approved: false });
                return reply(`<b>📝 Черновик для #${user.id}</b>\n\nЗдравствуйте! Ваша подписка заканчивается ${time(user.expireAt)} МСК. Для продления свяжитесь с поддержкой.\n\n<b>Сообщение не отправлено.</b> Подтверждение ниже только отмечает готовность черновика.`, keyboard([[button('✅ Подтвердить черновик', `approve:${key}`), button('Отменить', `cancel:${key}`)], [button('К списку', `page:${saved[2]}:0`)]]));
            }
            const approval = data?.match(/^(approve|cancel):([A-Za-z0-9_-]{8,24})$/);
            if (approval) {
                const draft = drafts.get(approval[2]);
                if (!draft || now() - draft.savedAt > 600000) throw new Error('REPORT_EXPIRED');
                drafts.delete(approval[2]);
                return reply(approval[1] === 'approve' ? '✅ Черновик подтверждён. <b>Клиенту ничего не отправлено.</b> Реальная отправка отключена.' : 'Черновик отменён. Клиенту ничего не отправлено.');
            }
            let intent;
            let source;
            const query = data?.match(/^q:([a-z_]+)(?::(\d+))?$/);
            const command = text.match(/^\/([a-z_]+)$/);
            if (query) {
                if (!reportActions.includes(query[1])) throw new Error('INVALID_ACTION');
                intent = { action: query[1], days: query[2] === undefined ? 3 : Number(query[2]) };
                if (!expiryWindows.includes(intent.days) || (intent.action !== 'expiring' && query[2] !== undefined)) throw new Error('INVALID_ACTION');
                source = 'direct';
            } else if (command && reportActions.includes(command[1]) && command[1] !== 'expiring') { intent = { action: command[1], days: 3 }; source = 'direct'; }
            else if (callback || text.startsWith('/')) return reply('Неизвестная команда. Используйте кнопки или /menu.');
            if (!intent && enhancedUi) {
                const validContext = context && now() >= context.savedAt && now() - context.savedAt < 600000 ? context.intent : undefined;
                const local = resolveLocalRequest(text, { context: validContext });
                if (local?.kind === 'clarify') return clarification(local.topic);
                if (local?.kind === 'blocked') return reply('Изменения панели и отправка клиентам недоступны. Используйте проверки чтения. ИИ не вызывался.');
                if (local?.kind === 'intent') {
                    intent = local.intent;
                    source = mcpRead ? 'mcp' : 'direct';
                    onDiagnostic({ event: 'intent', source: 'local', ok: true });
                }
            }
            if (busy || now() - lastRead < 5000) return reply('Дождитесь завершения запроса и повторите через пять секунд.');
            busy = true;
            lastRead = now();
            let stage = intent ? 'panel' : 'ai';
            try {
                if (!intent) {
                    if (!classify || !mcpRead) return reply('ИИ ещё не подключён. Кнопки работают без ИИ.');
                    intent = validateIntent(await classify(text));
                    source = 'mcp';
                }
                if (intent.action === 'help') return reply('Могу проверить статистику, пользователей онлайн, ноды, версию, подписки, ресурсы, трафик и счётчики конфигурации. Изменения и отправка клиентам недоступны.');
                stage = 'panel';
                const report = source === 'direct'
                    ? await service[intent.action](intent.action === 'expiring' ? { days: intent.days } : undefined)
                    : await mcpRead(intent.action, intent.days);
                const rendered = render(intent.action, report);
                context = { intent, savedAt: now() };
                onDiagnostic({ event: 'report', action: intent.action, source, ok: true });
                return rendered;
            } catch (error) {
                const aiCode = ['AI_PAUSED', 'AI_BRIDGE_UNAVAILABLE', 'AI_DAILY_LIMIT', 'AI_RATE_LIMIT', 'AI_BUSY', 'AI_NOT_CONFIGURED', 'AI_STATE_UNAVAILABLE', 'AI_CLOCK_UNAVAILABLE', 'AI_TEXT_REJECTED'].includes(error?.message) ? error.message : 'AI_UNAVAILABLE';
                onDiagnostic({ event: 'report', action: intent?.action ?? 'unknown', source: source ?? 'mcp', ok: false, code: stage === 'ai' ? aiCode : 'PANEL_READ_UNAVAILABLE' });
                throw error;
            } finally { busy = false; }
        } catch (error) {
            if (error?.message === 'LOCAL_CLARIFICATION_REQUIRED') return clarification('scope');
            if (error?.message === 'AI_PAUSED') return reply('ИИ на защитной паузе. Кнопки и уже известные вопросы работают без него. Для новых вопросов требуется проверка ИИ-модуля администратором.');
            if (error?.message === 'AI_BRIDGE_UNAVAILABLE') return reply('ИИ-модуль сейчас недоступен. Проверка готовности не расходует попытку. Используйте кнопки или знакомые вопросы.');
            if (error?.message === 'AI_UNAVAILABLE') return reply('ИИ временно недоступен или не смог безопасно распознать вопрос. Попытка учтена, автоматического повтора нет. Используйте кнопки или знакомые вопросы.');
            if (error?.message === 'AI_DAILY_LIMIT') return reply('Достигнут суточный лимит обращений к ИИ. Используйте кнопки или уже распознанные вопросы: данные панели будут свежими.');
            if (error?.message === 'AI_RATE_LIMIT' || error?.message === 'AI_BUSY') return reply('Новое обращение к ИИ возможно не чаще раза в минуту. Кнопки и известные вопросы не расходуют бюджет.');
            if (error?.message === 'AI_NOT_CONFIGURED') return reply('Этот вопрос пока не распознан локально, а ИИ ещё не подключён. Используйте кнопки или короткие команды, например «статистика», «проверь ноды».');
            if (error?.message === 'AI_TEXT_REJECTED') return reply('Для текстового вопроса используйте не более 500 символов, без токенов и ссылок. Кнопки работают без ИИ.');
            if (error?.message === 'AI_STATE_UNAVAILABLE' || error?.message === 'AI_CLOCK_UNAVAILABLE') return reply('Безопасный учёт ИИ недоступен, поэтому новый вызов запрещён. Кнопки работают без ИИ.');
            if (error?.message === 'USERS_READ_NOT_ENABLED') return reply('Отчёт о подписках ещё не включён: текущему интеграционному токену нужно отдельное разрешение <code>users:list</code>. Права панели не менялись.');
            if (error?.message === 'REPORT_EXPIRED') return reply('Сохранённый отчёт или черновик устарел. Выполните проверку заново.');
            return reply('Данные недоступны или запрос не поддерживается. Проверьте токен, права чтения и доступность ИИ. Изменения не выполнялись.');
        }
    };
}
