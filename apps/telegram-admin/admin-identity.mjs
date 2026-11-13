import { createHash } from 'node:crypto';
import { CreateUserCommand } from '@remnawave/backend-contract';

const transliteration = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g' };

export function forwardedIdentity(message) {
    const origin = message?.forward_origin;
    const user = origin?.type === 'user' ? origin.sender_user : !origin && !message?.forward_from_chat ? message?.forward_from : undefined;
    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || user.is_bot !== false || typeof user.first_name !== 'string' || user.first_name.length > 256 || (user.last_name !== undefined && (typeof user.last_name !== 'string' || user.last_name.length > 256))) return null;
    return { id: user.id, firstName: user.first_name, lastName: user.last_name ?? '', username: typeof user.username === 'string' && /^[A-Za-z0-9_]{5,32}$/.test(user.username) ? user.username : undefined };
}

export function panelUsername(name, { prefix = '', suffix = '' } = {}) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,36}$/.test(name)) throw new Error('ADMIN_INVALID_USERNAME');
    const wrapped = prefix + name + suffix;
    const result = CreateUserCommand.RequestBodySchema.shape.username.safeParse(wrapped);
    if (!result.success) throw new Error('ADMIN_INVALID_USERNAME');
    return result.data;
}

export function telegramName(identity, { prefix = '', suffix = '', telegramNameSource = 'profile' } = {}) {
    if (!identity || !Number.isSafeInteger(identity.id) || identity.id <= 0 || typeof identity.firstName !== 'string') throw new Error('ADMIN_TELEGRAM_IDENTITY_UNAVAILABLE');
    const raw = telegramNameSource === 'username' && identity.username ? identity.username : [identity.firstName, identity.lastName].filter(Boolean).join('_');
    let base = Array.from(raw.normalize('NFKC').toLowerCase()).map(character => transliteration[character] ?? character).join('').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^[_-]+|[_-]+$/g, '');
    if (!base) base = `id${identity.id}`;
    const maximum = 36 - prefix.length - suffix.length;
    if (base.length > maximum) {
        const tail = createHash('sha256').update(JSON.stringify([raw, identity.id])).digest('hex').slice(0, 6);
        base = base.slice(0, maximum - 7) + '_' + tail;
    }
    panelUsername(base, { prefix, suffix });
    return base;
}
