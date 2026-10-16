import { normalizeQuestion } from './intent-store.mjs';
import { validateIntent } from './intent.mjs';
import { resolveLocalRequest } from './local-router.mjs';

export function localIntent(text) {
    const local = resolveLocalRequest(text);
    return local?.kind === 'intent' ? local.intent : local?.kind === 'blocked' ? { action: 'help', days: 3 } : null;
}

export function createBudgetedIntent({ store, classify, onEvent = () => {} }) {
    let busy = false;
    return async text => {
        const normalized = normalizeQuestion(text);
        if (resolveLocalRequest(normalized)?.kind === 'clarify') throw new Error('LOCAL_CLARIFICATION_REQUIRED');
        const local = localIntent(normalized);
        if (local) { store.put(normalized, local); onEvent({ event: 'intent', source: 'local', ok: true }); return local; }
        const cached = store.get(normalized);
        if (cached) { onEvent({ event: 'intent', source: 'cache', ok: true }); return cached; }
        if (!classify) throw new Error('AI_NOT_CONFIGURED');
        if (busy) throw new Error('AI_BUSY');
        busy = true;
        try {
            await classify.checkReady?.();
            const quota = store.reserve();
            onEvent({ event: 'intent', source: 'ai', remaining: quota.remaining });
            const intent = validateIntent(await classify(text));
            store.put(normalized, intent);
            return intent;
        } finally { busy = false; }
    };
}
