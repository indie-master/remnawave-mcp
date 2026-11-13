import { formatLimit, parseGigabytes, trafficStrategies } from './admin-display.mjs';
import { panelUsername, telegramName } from './admin-identity.mjs';

export function createUserWizard({ administration, actorId, proposal, now = Date.now }) {
    let draft;
    const button = (text, callback_data) => ({ text, callback_data });
    const reply = (text, rows, parent = 'anew') => ({ text, reply_markup: { inline_keyboard: [...rows, [button('⬅ Назад', parent)]] } });
    const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    const enabled = () => administration.creationPolicy?.(actorId)?.enabled;
    function requireDraft() {
        if (!draft || now() < draft.at || now() - draft.at >= 600000) { draft = undefined; throw new Error('ADMIN_CREATE_EXPIRED'); }
    }
    const rows = items => Array.from({ length: Math.ceil(items.length / 2) }, (_, index) => items.slice(index * 2, index * 2 + 2));
    const body = () => Object.fromEntries(['username', 'days', 'trafficLimitBytes', 'trafficLimitStrategy', 'hwidDeviceLimit', 'activeInternalSquads', 'telegramId'].filter(field => draft[field] !== undefined).map(field => [field, draft[field]]));
    async function preview() {
        const ticket = await administration.prepareCreate(actorId, body());
        draft = undefined;
        return proposal(ticket, 'anew');
    }
    const handle = async ({ text = '', data, telegramForward = false, telegramIdentity }) => {
        if (telegramForward) {
            if (draft?.input !== 'telegramIdentity') return null;
            try {
                requireDraft();
                if (!telegramIdentity) return reply('Telegram скрыл отправителя или сообщение отправлено ботом. Перешлите текстовое сообщение с доступным отправителем либо выберите ручной ввод.', [[button('Ввести вручную', 'ncsource:manual')]]);
                const policy = administration.creationPolicy(actorId);
                draft.username = telegramName(telegramIdentity, policy);
                draft.telegramId = telegramIdentity.id;
                draft.input = undefined;
                if (draft.trial) { draft.days = 3; return await preview(); }
                return await handle({ data: 'ncdays' });
            } catch { draft = undefined; return reply('Не удалось получить корректное имя и Telegram ID. Начните создание заново.', []); }
        }
        const own = /^(?:anew|ncname:(?:trial|normal)|ncsource:(?:manual|telegram)|ncdays|ncd:\d{1,3}|nclimit|ncl:\d{1,5}|ncstrategy|ncs:[A-Z_]+|nchwid|nch:\d{1,3}|ncsquads|ncq:\d{1,2}|nctelegram|nctginput|ncpreview)$/.test(data ?? '');
        if (!own && (data || text.startsWith('/'))) { draft = undefined; return null; }
        if (!own && !draft?.input) return null;
        try {
            if (!enabled()) throw new Error('ADMIN_CREATE_DISABLED');
            if (data === 'anew') { draft = undefined; return reply('<b>➕ Новый пользователь</b>\nВыберите мастер или тестовую подписку с настроенными параметрами.', [[button('Пошаговый мастер', 'ncname:normal')], [button('Тест на 3 дня', 'ncname:trial')]], 'q:users'); }
            if (data?.startsWith('ncname:')) {
                const policy = administration.creationPolicy(actorId);
                const squads = await administration.creationSquads(actorId);
                draft = { at: now(), trial: data.endsWith('trial'), trafficLimitBytes: policy.trafficLimitBytes, trafficLimitStrategy: policy.strategy, hwidDeviceLimit: policy.hwidLimit, activeInternalSquads: squads.map(squad => squad.uuid) };
                return reply('Откуда взять имя нового пользователя?', [[button('Из Telegram', 'ncsource:telegram'), button('Ввести вручную', 'ncsource:manual')]]);
            }
            requireDraft();
            if (data === 'ncsource:manual') {
                delete draft.telegramId;
                draft.input = 'username';
                const policy = administration.creationPolicy(actorId);
                return reply(`Введите имя латинскими буквами, цифрами, «_» или «-». Префикс и суффикс будут добавлены из настроек. Максимум ${36 - (policy.prefix?.length ?? 0) - (policy.suffix?.length ?? 0)} символов для введённой части.`, []);
            }
            if (data === 'ncsource:telegram') {
                draft.input = 'telegramIdentity';
                return reply('Перешлите сюда обычное текстовое сообщение нужного пользователя. Имя и Telegram ID берутся из сведений об отправителе. Текст сообщения не используется.', [[button('Ввести вручную', 'ncsource:manual')]]);
            }
            if (!data && draft.input) {
                const field = draft.input;
                draft.input = undefined;
                if (field === 'telegramIdentity') { draft.input = field; return reply('Нужна пересылка сообщения с доступным отправителем. Для ручного ввода используйте кнопку.', [[button('Ввести вручную', 'ncsource:manual')]]); }
                if (field === 'username') {
                    panelUsername(text.trim(), administration.creationPolicy(actorId));
                    draft.username = text.trim();
                    if (draft.trial) { draft.days = 3; return await preview(); }
                    return await handle({ data: 'ncdays' });
                }
                if (!/^[1-9]\d{0,15}$/.test(text.trim()) || !Number.isSafeInteger(Number(text.trim()))) throw new Error('ADMIN_INVALID_CHANGE');
                draft.telegramId = Number(text.trim());
                return await preview();
            }
            if (data === 'ncdays') return reply('<b>Срок подписки</b>\nВыберите количество дней.', rows([3, 7, 30, 90, 180, 365].map(days => button(`${days} дн.`, `ncd:${days}`))));
            if (data?.startsWith('ncd:')) {
                const days = Number(data.slice(4));
                if (![3, 7, 30, 90, 180, 365].includes(days)) throw new Error('ADMIN_INVALID_CHANGE');
                draft.days = days;
                return await handle({ data: 'nclimit' });
            }
            if (data === 'nclimit') return reply('<b>Лимит трафика</b>\nГБ используются в значении 1024³ байт. Текущий выбор: ' + formatLimit(draft.trafficLimitBytes), rows([0, 16, 100, 300, 500, 1000].map(limit => button(limit ? `${limit} ГБ` : 'Без лимита', `ncl:${limit}`))), 'ncdays');
            if (data?.startsWith('ncl:')) {
                const value = data.slice(4);
                if (!['0', '16', '100', '300', '500', '1000'].includes(value)) throw new Error('ADMIN_INVALID_CHANGE');
                draft.trafficLimitBytes = parseGigabytes(value);
                return await handle({ data: 'ncstrategy' });
            }
            if (data === 'ncstrategy') return reply('<b>Стратегия сброса</b>', Object.entries(trafficStrategies).map(([strategy, label]) => [button(label, `ncs:${strategy}`)]), 'nclimit');
            if (data?.startsWith('ncs:')) {
                if (!Object.hasOwn(trafficStrategies, data.slice(4))) throw new Error('ADMIN_INVALID_CHANGE');
                draft.trafficLimitStrategy = data.slice(4);
                return await handle({ data: 'nchwid' });
            }
            if (data === 'nchwid') return reply('<b>Лимит устройств</b>', rows([1, 2, 3, 4, 5, 10].map(limit => button(String(limit), `nch:${limit}`))), 'ncstrategy');
            if (data?.startsWith('nch:')) {
                const limit = Number(data.slice(4));
                if (![1, 2, 3, 4, 5, 10].includes(limit)) throw new Error('ADMIN_INVALID_CHANGE');
                draft.hwidDeviceLimit = limit;
                return await handle({ data: 'ncsquads' });
            }
            if (data === 'ncsquads' || data?.startsWith('ncq:')) {
                const squads = await administration.creationSquads(actorId);
                if (data.startsWith('ncq:')) {
                    const squad = squads[Number(data.slice(4))];
                    if (!squad) throw new Error('ADMIN_INVALID_CHANGE');
                    draft.activeInternalSquads = draft.activeInternalSquads.includes(squad.uuid) ? draft.activeInternalSquads.filter(uuid => uuid !== squad.uuid) : [...draft.activeInternalSquads, squad.uuid];
                }
                return reply('<b>Группы доступа</b>\nОтметьте хотя бы одну группу из разрешённых в настройках.', [...squads.map((squad, index) => [button(`${draft.activeInternalSquads.includes(squad.uuid) ? '✓ ' : ''}${squad.name.slice(0, 52)}`, `ncq:${index}`)]), [button('Далее', 'nctelegram')]], 'nchwid');
            }
            if (data === 'nctelegram') {
                if (!draft.activeInternalSquads.length) throw new Error('ADMIN_INVALID_CHANGE');
                if (draft.telegramId) return reply(`<b>Telegram ID</b>\n${draft.telegramId} получен из пересланного сообщения.`, [[button('К предпросмотру', 'ncpreview')]], 'ncsquads');
                return reply('<b>Telegram ID</b>\nМожно указать числовой ID или перейти к предпросмотру.', [[button('Ввести Telegram ID', 'nctginput')], [button('Пропустить', 'ncpreview')]], 'ncsquads');
            }
            if (data === 'nctginput') { draft.input = 'telegramId'; return reply('Введите числовой Telegram ID.', [], 'nctelegram'); }
            if (data === 'ncpreview') return await preview();
            throw new Error('ADMIN_INVALID_CHANGE');
        } catch (error) {
            const message = { ADMIN_CREATE_DISABLED: 'Создание пользователей выключено или параметры доступа ещё не настроены.', ADMIN_CREATE_EXPIRED: 'Время заполнения истекло. Начните создание заново.', ADMIN_USERNAME_EXISTS: 'Это имя уже занято. Выберите другое.', ADMIN_INVALID_USERNAME: 'Имя с префиксом и суффиксом не соответствует требованиям панели. Используйте допустимые символы и сократите имя.', ADMIN_CREATE_UNCERTAIN: 'Для этого имени есть операция с неясным результатом. Сначала проверьте панель и журнал.' }[error?.message] ?? 'Параметры не приняты или панель недоступна. Проверьте данные и начните мастер заново.';
            draft = undefined;
            return reply(escape(message), [], 'anew');
        }
    };
    return handle;
}
