import { normalizeQuestion } from './intent-store.mjs';

export function validateSupportInput(value) {
    if (!value || Object.keys(value).sort().join(',') !== 'history,knowledge,question') throw new Error('AI_TEXT_REJECTED');
    normalizeQuestion(value.question);
    if (!Array.isArray(value.history) || value.history.length > 6 || !Array.isArray(value.knowledge) || value.knowledge.length > 4) throw new Error('AI_TEXT_REJECTED');
    for (const item of value.history) {
        if (!item || Object.keys(item).sort().join(',') !== 'role,text' || !['user', 'assistant'].includes(item.role) || typeof item.text !== 'string' || item.text.length > 300) throw new Error('AI_TEXT_REJECTED');
        normalizeQuestion(item.text);
    }
    for (const item of value.knowledge) {
        if (!item || Object.keys(item).sort().join(',') !== 'id,text' || !/^[a-z0-9_-]{1,40}$/.test(item.id) || typeof item.text !== 'string' || item.text.length > 500) throw new Error('AI_TEXT_REJECTED');
        normalizeQuestion(item.text);
    }
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 4096) throw new Error('AI_TEXT_REJECTED');
    return value;
}

export function validateSupportReply(value) {
    if (!value || Object.keys(value).sort().join(',') !== 'needsHuman,reply' || typeof value.reply !== 'string' || !value.reply.trim() || value.reply.length > 1200 || typeof value.needsHuman !== 'boolean' || /https?:\/\/|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(value.reply)) throw new Error('AI_UNAVAILABLE');
    return value;
}
