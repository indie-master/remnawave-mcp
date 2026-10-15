import { normalizeQuestion } from './intent-store.mjs';
import { validateIntent } from './intent.mjs';

export function localIntent(text) {
    const normalized = normalizeQuestion(text);
    if (/\b(?:delete|update|create|notify|password|token|secret|ssh|docker)\b|(?:удали|отключи|заблокируй|отправь|парол|токен|секрет)/i.test(normalized)) return { action: 'help', days: 3 };
    const aliases = {
        stats: ['статистика', 'покажи статистику', 'проверь статистику'],
        nodes: ['ноды', 'проверь ноды', 'состояние нод'],
        version: ['версия', 'версия панели'],
    };
    for (const [action, values] of Object.entries(aliases)) if (values.includes(normalized)) return { action, days: 3 };
    if (['у кого скоро истекает подписка', 'истекающие подписки'].includes(normalized)) return { action: 'expiring', days: 3 };
    const periods = new Map([['один день', 1], ['три дня', 3], ['неделю', 7], ['две недели', 14], ['месяц', 30]]);
    for (const days of [1, 3, 7, 14, 30]) periods.set(`${days} ${days === 1 ? 'день' : days === 3 ? 'дня' : 'дней'}`, days);
    for (const [period, days] of periods) {
        if ([`у кого истекает подписка в ближайшие ${period}`, `у кого истекает подписка в ближайшую ${period}`, `у кого истекает подписка в ближайший ${period}`, `истекающие подписки за ${period}`].includes(normalized)) return { action: 'expiring', days };
    }
    return null;
}

export function createBudgetedIntent({ store, classify, onEvent = () => {} }) {
    let busy = false;
    return async text => {
        const normalized = normalizeQuestion(text);
        const local = localIntent(normalized);
        if (local) { store.put(normalized, local); onEvent({ event: 'intent', source: 'local', ok: true }); return local; }
        const cached = store.get(normalized);
        if (cached) { onEvent({ event: 'intent', source: 'cache', ok: true }); return cached; }
        if (!classify) throw new Error('AI_NOT_CONFIGURED');
        if (busy) throw new Error('AI_BUSY');
        busy = true;
        try {
            const quota = store.reserve();
            onEvent({ event: 'intent', source: 'ai', remaining: quota.remaining });
            const intent = validateIntent(await classify(text));
            store.put(normalized, intent);
            return intent;
        } finally { busy = false; }
    };
}
