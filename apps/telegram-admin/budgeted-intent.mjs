import { normalizeQuestion } from './intent-store.mjs';
import { validateIntent } from './intent.mjs';
import { resolveLocalRequest } from './local-router.mjs';

export function localIntent(text) {
    const local = resolveLocalRequest(text);
    return local?.kind === 'intent' ? local.intent : local?.kind === 'blocked' ? { action: 'help', days: 3 } : null;
}

export function createBudgetedIntent({ store, classify, onEvent = () => {} }) {
    let busy = false;
    const resolveKnown = text => {
        const normalized = normalizeQuestion(text);
        const localRequest = resolveLocalRequest(normalized);
        if (localRequest?.kind === 'clarify') throw Object.assign(new Error('LOCAL_CLARIFICATION_REQUIRED'), { topic: localRequest.topic });
        const local = localIntent(normalized);
        if (local) { store.put(normalized, local); onEvent({ event: 'intent', source: 'local', ok: true }); return local; }
        const cached = store.get(normalized);
        if (cached) { onEvent({ event: 'intent', source: 'cache', ok: true }); return cached; }
        return null;
    };
    const resolve = async text => {
        const known = resolveKnown(text);
        if (known) return known;
        if (!classify) throw new Error('AI_NOT_CONFIGURED');
        if (busy) throw new Error('AI_BUSY');
        busy = true;
        try {
            await classify.checkReady?.();
            const quota = store.reserve();
            onEvent({ event: 'intent', source: 'ai', remaining: quota.remaining });
            const intent = validateIntent(await classify(text));
            store.put(text, intent);
            return intent;
        } finally { busy = false; }
    };
    return Object.assign(resolve, { resolveKnown });
}
