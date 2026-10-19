import { normalizeQuestion } from './intent-store.mjs';

const plan = (action, days = 3) => ({ kind: 'intent', intent: { action, days } });
const clarify = topic => ({ kind: 'clarify', topic });
const periods = new Map([
    ['день', 1], ['один день', 1], ['сутки', 1], ['1 день', 1], ['1 сутки', 1],
    ['три дня', 3], ['3 дня', 3], ['неделю', 7], ['неделя', 7], ['недели', 7], ['7 дней', 7],
    ['две недели', 14], ['2 недели', 14], ['14 дней', 14], ['месяц', 30], ['30 дней', 30],
]);

function periodOf(text) {
    const stripped = text.replace(/^(?:за|на|в течение|в ближайшие|в ближайшую|в ближайший|в ближайшие следующие|ближайшие|ближайшую|ближайший) /, '');
    return periods.get(stripped);
}

export function resolveLocalRequest(text, { context } = {}) {
    const normalized = normalizeQuestion(text).replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    if (!normalized) return clarify('scope');
    if (/(?:^|\s)(?:delete|update|create|notify|password|token|secret|ssh|docker|restart|reset|enable|disable)(?:\s|$)|(?:удал|отключ|заблок|разблок|отправь|отправить|рассыл|продли|продлить|обнови|перезапуст|сброс|измени|созда|парол|токен|секрет)/.test(normalized)) return { kind: 'blocked' };
    if (/(?:^|\s)(?:не|кроме|без|исключая|not|except)(?:\s|$)/.test(normalized)) return clarify('scope');
    let phrase = normalized.replace(/^(?:а |и )/, '').replace(/,? пожалуйста(?:,)?/g, ' ').replace(/\s+/g, ' ').trim();
    phrase = phrase.replace(/^(?:(?:покажи|покажите|пришли|проверь|проверить|дай|выведи|подскажи|скажи|сколько|какое|какая|какие|хочу узнать|можешь показать|можно узнать)\s+)+(?:в\s+)?/, '').trim();
    phrase = phrase.replace(/^общую статистику(?= |$)/, 'общая статистика').replace(/^статистику(?= |$)/, 'статистика');
    if (/^(?:а |и )/.test(normalized) && /^(?:онлайн|сейчас|сейчас онлайн|кто онлайн)$/.test(phrase)) {
        if (['nodes', 'node_details'].includes(context?.action)) return plan('nodes');
        if (['stats', 'users', 'online'].includes(context?.action)) return plan('online');
        return clarify('scope');
    }
    if (/^(?:статистика|общая статистика|статистика панели|общая сводка|сводка панели)$/.test(phrase)) return plan('stats');
    if (/^(?:(?:количество|число|всего|общее количество) )?(?:пользователей|юзеров|клиентов|пользователи|юзеры)(?: всего| в панели| зарегистрировано)?$/.test(phrase)) return plan('users');
    if (/^(?:статистика пользователей|статистика клиентов|пользователи по статусам|статусы пользователей|сводка о клиентах)$/.test(phrase)) return plan('users');
    if (/^(?:(?:количество|число|всего) )?(?:(?:пользователей|юзеров|клиентов) )?(?:онлайн|online|сейчас онлайн|онлайн сейчас)(?: пользователей| юзеров| клиентов)?$/.test(phrase)) return plan('online');
    if (/^(?:версия|версия панели|версию|версию панели)$/.test(phrase)) return plan('version');
    if (/^(?:ноды|серверы|состояние нод|состояние серверов|статистика нод|статистика серверов|статистика по нодам|статистика по серверам|сколько нод|количество нод|нод|серверов)$/.test(phrase)) return plan('nodes');
    if (/^(?:список нод|список серверов|подробно о нодах|нодах|онлайн на нодах|пользователей на нодах|юзеров на нодах)$/.test(phrase)) return plan('node_details');
    if (/^(?:хосты|количество хостов|хостов)$/.test(phrase)) return plan('hosts');
    if (/^(?:профили|профили конфигурации|конфигурационные профили|количество профилей)$/.test(phrase)) return plan('profiles');
    if (/^(?:внутренние сквады|внутренние группы|internal squads)$/.test(phrase)) return plan('internal_squads');
    if (/^(?:внешние сквады|внешние группы|external squads)$/.test(phrase)) return plan('external_squads');
    if (/^(?:ресурсы панели|память панели|нагрузка панели|система|системная статистика|систему)$/.test(phrase)) return plan('system');
    if (/^(?:трафик|общий трафик|статистика трафика|трафик панели)$/.test(phrase)) return plan('bandwidth');
    if (/^(?:здоровье панели|процессы панели|состояние процессов панели)$/.test(phrase)) return plan('health');
    if (/^(?:помощь|меню|что умеешь)$/.test(phrase)) return plan('help');
    if (/^(?:сквады|группы)$/.test(phrase)) return clarify('squads');
    if (/^(?:состояние|статус|онлайн серверов|статистика онлайн)$/.test(phrase)) return clarify('scope');
    if (/^(?:у кого скоро истекает подписка|истекающие подписки|скоро истекающие подписки)$/.test(phrase)) return plan('expiring');
    const expiry = phrase.match(/^(?:у кого (?:скоро )?истекает подписка|истекающие подписки|подписки|окончание подписок)(?: (.+))?$/);
    if (expiry) {
        if (!expiry[1]) return clarify('period');
        const days = periodOf(expiry[1]);
        return days ? plan('expiring', days) : clarify('period');
    }
    if (/^(?:сейчас|сейчас онлайн|кто онлайн|а онлайн)$/.test(phrase)) {
        if (['nodes', 'node_details'].includes(context?.action)) return plan('nodes');
        if (['stats', 'users', 'online'].includes(context?.action)) return plan('online');
        return clarify('scope');
    }
    const followup = periodOf(phrase);
    if (followup) return context?.action === 'expiring' ? plan('expiring', followup) : clarify('period');
    if (/^(?:за|на|до|после|через|с|в течение) /.test(phrase) && /(?:\d|день|дня|дней|сутки|недел|месяц)/.test(phrase)) return clarify('period');
    if (/^\d/.test(phrase)) return clarify('period');
    if (/^(?:офлайн|всего|подробнее)$/.test(phrase)) {
        if (['nodes', 'node_details'].includes(context?.action)) return plan(phrase === 'подробнее' ? 'node_details' : 'nodes');
        if (phrase === 'всего' && ['stats', 'users', 'online'].includes(context?.action)) return plan('users');
        return clarify('scope');
    }
    if (/(?:статистик|пользоват|юзер|клиент|нод|сервер|подписк|онлайн|профил|сквад|трафик|хост)/.test(phrase)) return clarify('scope');
    return null;
}
