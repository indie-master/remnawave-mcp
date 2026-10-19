import { request } from 'node:http';

export async function transcribeVoice(bytes, { requestImpl = request, signal, maxSeconds = 30 } = {}) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > 2097152 || bytes.subarray(0, 4).toString() !== 'OggS') throw new Error('VOICE_REJECTED');
    return new Promise((resolve, reject) => {
        const fail = () => reject(new Error('VOICE_UNAVAILABLE'));
        const call = requestImpl({ socketPath: '/voice/transcribe.sock', method: 'POST', path: '/transcribe', headers: { 'Content-Type': 'audio/ogg', 'Content-Length': bytes.length, 'X-Max-Seconds': maxSeconds }, signal, timeout: 45000 }, response => {
            const chunks = []; let length = 0;
            response.on('data', chunk => { length += chunk.length; if (length > 4096) response.destroy(); else chunks.push(chunk); });
            response.on('error', fail);
            response.on('end', () => {
                try {
                    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    if (response.statusCode !== 200 || typeof data.text !== 'string' || !data.text.trim() || data.text.length > 500 || data.confident !== true) throw new Error();
                    resolve(data.text.trim());
                } catch { reject(new Error('VOICE_UNCERTAIN')); }
            });
        });
        call.on('timeout', () => call.destroy()); call.on('error', fail); call.end(bytes);
    });
}

export function createVoiceInput({ api, allowedUserId, transcribe = transcribeVoice, maxSeconds = 30, maxBytes = 1048576, now = Date.now }) {
    let last = -Infinity;
    return async update => {
        const message = update?.message;
        if (!message?.voice) return update;
        if (message.chat?.type !== 'private' || message.chat.id !== allowedUserId || message.from?.id !== allowedUserId || message.from.is_bot !== false || message.forward_origin || message.forward_from || message.forward_from_chat || !Number.isSafeInteger(message.date) || now() / 1000 - message.date > 120 || now() / 1000 - message.date < -15) return null;
        const voice = message.voice;
        if (!Number.isInteger(voice.duration) || voice.duration < 1 || voice.duration > maxSeconds || voice.mime_type !== 'audio/ogg' || !Number.isSafeInteger(voice.file_size) || voice.file_size < 16 || voice.file_size > maxBytes || now() - last < 15000) throw new Error('VOICE_REJECTED');
        last = now();
        const bytes = await api.downloadVoice(voice.file_id, maxBytes);
        const text = await transcribe(bytes, { maxSeconds });
        return { ...update, inputSource: 'local-voice', message: { ...message, voice: undefined, text } };
    };
}
