import { randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, statSync } from 'node:fs';
import { GetUserByIdCommand, GetUserByUsernameCommand, UpdateUserCommand } from '@remnawave/backend-contract';
import { RemnawaveClient } from '../../dist/client.js';

export const editableFields = ['status', 'expireAt', 'description', 'email', 'telegramId', 'trafficLimitBytes', 'tag', 'hwidDeviceLimit'];
const numericId = value => /^\d{1,16}$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
const reference = value => typeof value === 'string' && (numericId(value) || /^[A-Za-z0-9_-]{3,36}$/.test(value));
const digest = user => createHash('sha256').update(JSON.stringify([user.id, ...editableFields.map(field => user[field] ?? null)])).digest('hex');

export function createUserClient({ baseUrl, readTokenFile, writeTokenFile = '/run/secrets/panel_write_token', signal }) {
    const origin = new URL(baseUrl);
    if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash) throw new Error('ADMIN_CONFIGURATION_INVALID');
    function client(file) {
        if (signal?.aborted || statSync(file).size > 4096) throw new Error('ADMIN_UNAVAILABLE');
        const token = readFileSync(file, 'utf8').trim();
        if (!token || /\s/.test(token)) throw new Error('ADMIN_UNAVAILABLE');
        return new RemnawaveClient({ baseUrl: origin.origin, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeoutMs: 15000, maxResponseBytes: 1024 * 1024 });
    }
    return {
        async get(ref) {
            if (!reference(ref)) throw new Error('ADMIN_INVALID_REFERENCE');
            const command = numericId(ref) ? GetUserByIdCommand : GetUserByUsernameCommand;
            return client(readTokenFile).request('GET', command.url(numericId(ref) ? Number(ref) : ref));
        },
        async patch(body) { return client(writeTokenFile).request('PATCH', UpdateUserCommand.url, undefined, UpdateUserCommand.RequestBodySchema.parse(body)); },
    };
}

export function createUserAdministration({ filename, client, actorId, readEnabled = false, writeEnabled = false, allowedFields = ['status', 'expireAt', 'description'], now = Date.now }) {
    if (!Number.isSafeInteger(actorId) || actorId <= 0 || !Array.isArray(allowedFields) || !allowedFields.length || new Set(allowedFields).size !== allowedFields.length || allowedFields.some(field => !editableFields.includes(field)) || (writeEnabled && !readEnabled)) throw new Error('ADMIN_CONFIGURATION_INVALID');
    const database = new DatabaseSync(filename);
    database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS confirmations (id TEXT PRIMARY KEY, actor INTEGER NOT NULL, target TEXT NOT NULL, operation TEXT NOT NULL, payload TEXT NOT NULL, baseline TEXT NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, action TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL);');
    let busy = false;
    let lastRead = -Infinity;
    function authorize(actor) { if (actor !== actorId || !readEnabled) throw new Error('ADMIN_DISABLED'); }
    async function get(ref) {
        if (!reference(ref)) throw new Error('ADMIN_INVALID_REFERENCE');
        const user = await client.get(ref);
        if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.username !== 'string' || !['ACTIVE', 'DISABLED', 'LIMITED', 'EXPIRED'].includes(user.status)) throw new Error('ADMIN_UNAVAILABLE');
        if (numericId(ref) ? user.id !== Number(ref) : user.username !== ref) throw new Error('ADMIN_UNAVAILABLE');
        return user;
    }
    function ticket(user, operation, payload) {
        database.prepare('DELETE FROM confirmations WHERE expires < ? AND state != ?').run(now() - 86400000, 'executing');
        if (database.prepare('SELECT count(*) AS count FROM confirmations WHERE state = ?').get('pending').count > 50) throw new Error('ADMIN_BUSY');
        const id = randomBytes(12).toString('base64url');
        database.prepare('INSERT INTO confirmations VALUES (?,?,?,?,?,?,?,?)').run(id, actorId, String(user.id), operation, JSON.stringify(payload), digest(user), now() + 180000, 'pending');
        return { id, operation, target: user.id, changes: payload, expiresInSeconds: 180, confirmationRequired: true };
    }
    async function exclusive(work) {
        if (busy || now() - lastRead < 2000) throw new Error('ADMIN_BUSY');
        busy = true; lastRead = now();
        try { return await work(); } finally { busy = false; }
    }
    return {
        policy(actor) { authorize(actor); return { writeEnabled, fields: [...allowedFields] }; },
        hasInFlight(actor) { authorize(actor); return busy; },
        operations(actor) {
            authorize(actor);
            return database.prepare('SELECT id,target,operation,state,expires FROM confirmations WHERE actor=? ORDER BY expires DESC,id DESC LIMIT 20').all(actor).map(entry => ({ ...entry, state: entry.state === 'pending' && entry.expires < now() ? 'expired' : entry.state }));
        },
        async card(actor, ref) {
            authorize(actor);
            return exclusive(async () => {
                const user = await get(ref);
                return { id: user.id, username: user.username, status: user.status, expireAt: user.expireAt, trafficLimitBytes: user.trafficLimitBytes, trafficUsedBytes: user.userTraffic?.usedTrafficBytes ?? null, telegramLinked: user.telegramId != null, description: typeof user.description === 'string' ? user.description.slice(0, 300) : '', observedAt: new Date(now()).toISOString() };
            });
        },
        async prepare(actor, ref, changes) {
            authorize(actor);
            if (!writeEnabled) throw new Error('ADMIN_WRITE_DISABLED');
            if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length || Object.keys(changes).some(field => !allowedFields.includes(field))) throw new Error('ADMIN_FIELD_DISABLED');
            if (changes.status !== undefined && !['ACTIVE', 'DISABLED'].includes(changes.status)) throw new Error('ADMIN_INVALID_CHANGE');
            return exclusive(async () => {
                const user = await get(ref);
                const body = UpdateUserCommand.RequestBodySchema.parse({ id: user.id, ...changes });
                const validated = Object.fromEntries(Object.keys(changes).map(field => [field, body[field]]));
                if (JSON.stringify(validated).length > 2048) throw new Error('ADMIN_INVALID_CHANGE');
                return ticket(user, 'patch', validated);
            });
        },
        async prepareSubscription(actor, ref) {
            authorize(actor);
            return exclusive(async () => ticket(await get(ref), 'subscription', {}));
        },
        async prepareRenewal(actor, ref, days) {
            authorize(actor);
            if (!writeEnabled || !allowedFields.includes('expireAt')) throw new Error('ADMIN_WRITE_DISABLED');
            if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error('ADMIN_INVALID_CHANGE');
            return exclusive(async () => {
                const user = await get(ref);
                const previous = Date.parse(user.expireAt);
                if (!Number.isFinite(previous)) throw new Error('ADMIN_UNAVAILABLE');
                const expireAt = new Date(Math.max(now(), previous) + days * 86400000).toISOString();
                UpdateUserCommand.RequestBodySchema.parse({ id: user.id, expireAt });
                return ticket(user, 'patch', { expireAt });
            });
        },
        cancel(actor, id) {
            authorize(actor);
            database.prepare('UPDATE confirmations SET state = ?, payload = ? WHERE id = ? AND actor = ? AND state = ?').run('cancelled', '{}', id, actor, 'pending');
        },
        preview(actor, id) {
            authorize(actor);
            const entry = database.prepare('SELECT * FROM confirmations WHERE id=? AND actor=? AND state=? AND expires>=?').get(id, actor, 'pending', now());
            if (!entry) throw new Error('ADMIN_CONFIRMATION_EXPIRED');
            return { id: entry.id, operation: entry.operation, target: entry.target, changes: JSON.parse(entry.payload) };
        },
        receipt(actor, id) {
            authorize(actor);
            return database.prepare('SELECT state FROM confirmations WHERE id=? AND actor=?').get(id, actor)?.state ?? 'unknown';
        },
        async confirm(actor, id) {
            authorize(actor);
            if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(id)) throw new Error('ADMIN_CONFIRMATION_EXPIRED');
            if (busy) throw new Error('ADMIN_BUSY');
            const entry = database.prepare('SELECT * FROM confirmations WHERE id = ? AND actor = ? AND state = ? AND expires >= ?').get(id, actor, 'pending', now());
            if (!entry) throw new Error('ADMIN_CONFIRMATION_EXPIRED');
            if (entry.operation === 'patch' && !writeEnabled) throw new Error('ADMIN_WRITE_DISABLED');
            const claim = database.prepare('UPDATE confirmations SET state = ? WHERE id = ? AND state = ?').run('executing', id, 'pending');
            if (claim.changes !== 1) throw new Error('ADMIN_CONFIRMATION_EXPIRED');
            busy = true;
            let state = 'rejected';
            try {
                const user = await get(entry.target);
                if (digest(user) !== entry.baseline) throw new Error('ADMIN_STALE');
                if (entry.operation === 'subscription') {
                    const url = new URL(user.subscriptionUrl);
                    if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2048) throw new Error('ADMIN_UNAVAILABLE');
                    state = 'done'; return { subscriptionUrl: url.href };
                }
                const changes = JSON.parse(entry.payload);
                if (Object.keys(changes).some(field => !allowedFields.includes(field))) throw new Error('ADMIN_FIELD_DISABLED');
                state = 'uncertain';
                await client.patch(UpdateUserCommand.RequestBodySchema.parse({ id: user.id, ...changes }));
                state = 'done'; return { changed: true };
            } finally {
                database.prepare('UPDATE confirmations SET state = ?, payload = ? WHERE id = ?').run(state, '{}', id);
                database.prepare('INSERT INTO audit VALUES (?,?,?,?)').run(id, entry.operation, state, now());
                busy = false;
            }
        },
        close: () => database.close(),
    };
}

export function createAdminHandler({ administration, actorId, renewalDays = [1, 7, 30, 90], now = Date.now }) {
    if (!Number.isSafeInteger(actorId) || actorId <= 0 || !Array.isArray(renewalDays) || !renewalDays.length || renewalDays.length > 8 || new Set(renewalDays).size !== renewalDays.length || renewalDays.some(days => !Number.isInteger(days) || days < 1 || days > 366)) throw new Error('ADMIN_CONFIGURATION_INVALID');
    let input;
    let userSection = false;
    const escape = value => String(value ?? 'нет данных').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    const response = (text, rows = [[{ text: '🏠 Меню', callback_data: 'home' }]]) => ({ text, reply_markup: { inline_keyboard: rows } });
    const proposal = ticket => response(`<b>Подтверждение администратора</b>\nПользователь: <code>${escape(ticket.target)}</code>\n${ticket.operation === 'subscription' ? 'Показать секретную ссылку подписки только в этом чате.' : `Изменения: <code>${escape(JSON.stringify(ticket.changes))}</code>`}\nДействует 3 минуты. ИИ не может подтвердить действие.`, [[{ text: '✅ Подтвердить', callback_data: `ac:${ticket.id}` }, { text: 'Отмена', callback_data: `ax:${ticket.id}` }]]);
    const policy = () => administration.policy?.(actorId) ?? { writeEnabled: false, fields: [] };
    const navigation = [[{ text: '🔎 Найти пользователя', callback_data: 'admin_search' }, { text: '🗒 Операции', callback_data: 'admin_operations' }], [{ text: '🏠 Меню', callback_data: 'home' }]];
    const labels = { status: 'Статус', expireAt: 'Окончание подписки', description: 'Описание', email: 'Почта', telegramId: 'Telegram ID', trafficLimitBytes: 'Лимит трафика в байтах', tag: 'Метка', hwidDeviceLimit: 'Лимит устройств' };
    const card = async ref => {
        const user = await administration.card(actorId, ref);
        const permissions = policy();
        const rows = [[{ text: '🔗 Подписка', callback_data: `al:${user.id}` }]];
        if (permissions.writeEnabled && permissions.fields.includes('expireAt')) rows.push([{ text: '⏳ Продлить', callback_data: `ar:${user.id}` }]);
        if (permissions.writeEnabled && permissions.fields.length) rows.push([{ text: '✏️ Изменить данные', callback_data: `av:${user.id}` }]);
        if (permissions.writeEnabled && permissions.fields.includes('status')) rows.push([{ text: 'Включить', callback_data: `ae:${user.id}` }, { text: 'Отключить', callback_data: `ad:${user.id}` }]);
        rows.push([{ text: '🔄 Обновить', callback_data: `au:${user.id}` }, { text: '🔎 Другой пользователь', callback_data: 'admin_search' }], [{ text: '🏠 Меню', callback_data: 'home' }]);
        return response(`<b>👤 ${escape(user.username)}</b>\nID: <code>${escape(user.id)}</code>\nСтатус: ${escape(user.status)}\nДо: ${escape(user.expireAt)}\nТрафик: ${escape(user.trafficUsedBytes)} / ${escape(user.trafficLimitBytes)} байт\nTelegram: ${user.telegramLinked ? 'привязан' : 'не привязан'}\nОписание: ${escape(user.description)}\nПроверено: ${escape(user.observedAt)}`, rows);
    };
    return async ({ text = '', data, allowedUserId }) => {
        if (allowedUserId !== actorId) return null;
        const priorInput = input;
        if (data || text.startsWith('/') || /^(?:плат[её]ж|ответ|сверка)\s+[a-f0-9]{24}(?:\s|$)/i.test(text)) { input = undefined; userSection = false; }
        const match = text.match(/^(?:(?:покажи|открой|найди)\s+)?(?:пользователь|пользователя|юзер|юзера|user)\s+(?:(?:с\s+)?id\s+|#)?([A-Za-z0-9_-]{1,36})$/i);
        const edit = text.match(/^(?:измени|изменить)\s+([A-Za-z0-9_-]{1,36})\s+([A-Za-z]+)=(.{1,500})$/i);
        const subscription = text.match(/^(?:подписка|ссылка подписки)\s+([A-Za-z0-9_-]{1,36})$/i);
        const pending = text.match(/^заявка\s+([A-Za-z0-9_-]{16})$/);
        const renewal = text.match(/^(?:продли|продлить)\s+(?:пользователя\s+)?([A-Za-z0-9_-]{1,36})\s+на\s+(\d{1,3})\s+(?:день|дня|дней)$/i);
        const statusChange = text.match(/^(включи|отключи)\s+(?:пользователя\s+)?([A-Za-z0-9_-]{1,36})$/i);
        if (!input && /^подписка\s+[А-Яа-яЁё]/.test(text)) { userSection = false; return null; }
        const interactive = /^(?:admin_home|admin_search|admin_cancel_input|admin_operations|a[rv]:\d{1,16}|ap:\d{1,16}:\d{1,3}|af:\d{1,16}:[A-Za-z]+)$/.test(data ?? '');
        const inactiveReference = !data && !input && userSection && reference(text.trim());
        if (!match && !edit && !subscription && !pending && !renewal && !statusChange && !input && !interactive && !inactiveReference && !/^(?:ac:|ax:|al:|au:|ad:|ae:)/.test(data ?? '') && !/^(?:пользователь|юзер|user|измени|изменить|подписка|ссылка подписки|заявка|продли|продлить|включи|отключи)(?:\s|$)/i.test(text)) { userSection = false; return null; }
        try {
            userSection = true;
            if (data === 'admin_home' || data === 'admin_search') { input = { kind: 'search', at: now() }; return response('<b>Поиск пользователя</b>\nВведите точный числовой ID или username без дополнительных слов. Ввод действует 2 минуты; похожие имена не подбираются. ИИ не используется.', [[{ text: 'Отмена', callback_data: 'admin_cancel_input' }, { text: '🗒 Операции', callback_data: 'admin_operations' }], [{ text: '🏠 Меню', callback_data: 'home' }]]); }
            if (data === 'admin_cancel_input') return response('Ввод отменён. Панель не изменялась.', navigation);
            if (data === 'admin_operations') {
                const entries = administration.operations?.(actorId) ?? [];
                return response('<b>Последние сохранённые операции</b>\n' + (entries.length ? entries.map(entry => `#${escape(entry.target)} · ${escape(entry.operation)} · ${escape(entry.state)}\n<code>${escape(entry.id)}</code>`).join('\n\n') : 'Операций пока нет.') + '\n\nexecuting / uncertain требуют проверки, а не повторной отправки. Полезная нагрузка и секретные ссылки не показываются.', navigation);
            }
            const renewPreset = data?.match(/^ap:(\d{1,16}):(\d{1,3})$/);
            if (renewPreset) {
                if (!renewalDays.includes(Number(renewPreset[2]))) throw new Error('ADMIN_INVALID_CHANGE');
                return proposal(await administration.prepareRenewal(actorId, renewPreset[1], Number(renewPreset[2])));
            }
            const renewMenu = data?.match(/^ar:(\d{1,16})$/);
            if (renewMenu) {
                if (!policy().writeEnabled || !policy().fields.includes('expireAt')) throw new Error('ADMIN_WRITE_DISABLED');
                return response('На сколько дней продлить? После выбора будет только предпросмотр, без изменения панели.', [...renewalDays.map(days => [{ text: `+${days} дн.`, callback_data: `ap:${renewMenu[1]}:${days}` }]), [{ text: 'К карточке', callback_data: `au:${renewMenu[1]}` }]]);
            }
            const fieldsMenu = data?.match(/^av:(\d{1,16})$/);
            if (fieldsMenu) {
                if (!policy().writeEnabled) throw new Error('ADMIN_WRITE_DISABLED');
                return response('Выберите разрешённое поле. Значение будет проверено по контракту панели, затем потребуется подтверждение.', [...policy().fields.map(field => [{ text: labels[field], callback_data: `af:${fieldsMenu[1]}:${field}` }]), [{ text: 'К карточке', callback_data: `au:${fieldsMenu[1]}` }]]);
            }
            const fieldInput = data?.match(/^af:(\d{1,16}):([A-Za-z]+)$/);
            if (fieldInput) {
                if (!policy().writeEnabled || !policy().fields.includes(fieldInput[2])) throw new Error('ADMIN_FIELD_DISABLED');
                input = { kind: 'field', target: fieldInput[1], field: fieldInput[2], at: now() };
                return response(`Введите новое значение: ${escape(labels[fieldInput[2]])}.\nДля статуса: ACTIVE или DISABLED; для даты — ISO8601 с часовым поясом; числовые лимиты — целым числом. Ввод действует 2 минуты.`, [[{ text: 'Отмена', callback_data: 'admin_cancel_input' }]]);
            }
            if (inactiveReference && !match && !edit && !subscription && !pending && !renewal && !statusChange) return response('Для поиска нажмите «Найти пользователя» и отправьте ID или username после приглашения. Панель и ИИ не запрашивались; число не считается периодом подписки.', navigation);
            if (!data && input && !match && !edit && !subscription && !pending && !renewal && !statusChange) {
                const value = input; input = undefined;
                if (now() < value.at || now() - value.at >= 120000) return response('Время ввода истекло. Откройте действие заново.', navigation);
                if (value.kind === 'search') {
                    if (!reference(text.trim())) return response('Нужен точный ID или username; панель и ИИ не запрашивались.', navigation);
                    return await card(text.trim());
                }
                if (!text.length || text.length > 500) throw new Error('ADMIN_INVALID_CHANGE');
                const converted = ['trafficLimitBytes', 'hwidDeviceLimit', 'telegramId'].includes(value.field) ? Number(text) : text;
                return proposal(await administration.prepare(actorId, value.target, { [value.field]: converted }));
            }
            if (priorInput && (match || edit || subscription || pending || renewal || statusChange)) input = undefined;
            if (pending) return proposal(administration.preview(actorId, pending[1]));
            if (renewal) return proposal(await administration.prepareRenewal(actorId, renewal[1], Number(renewal[2])));
            if (statusChange) return proposal(await administration.prepare(actorId, statusChange[2], { status: statusChange[1].toLowerCase() === 'включи' ? 'ACTIVE' : 'DISABLED' }));
            if (data?.startsWith('ac:')) {
                const result = await administration.confirm(actorId, data.slice(3));
                return response(result.subscriptionUrl ? `<b>Ссылка подписки — не пересылайте её</b>\n<code>${escape(result.subscriptionUrl)}</code>` : '✅ Изменение подтверждено панелью.');
            }
            if (data?.startsWith('ax:')) { administration.cancel(actorId, data.slice(3)); return response('Отменено.'); }
            if (subscription || data?.startsWith('al:')) return proposal(await administration.prepareSubscription(actorId, subscription?.[1] ?? data.slice(3)));
            if (edit) {
                const field = edit[2];
                const value = ['trafficLimitBytes', 'hwidDeviceLimit', 'telegramId'].includes(field) ? Number(edit[3]) : edit[3];
                return proposal(await administration.prepare(actorId, edit[1], { [field]: value }));
            }
            if (/^a[de]:/.test(data ?? '')) return proposal(await administration.prepare(actorId, data.slice(3), { status: data.startsWith('ae:') ? 'ACTIVE' : 'DISABLED' }));
            return await card(match?.[1] ?? data?.slice(3));
        } catch (error) {
            const messages = { ADMIN_WRITE_DISABLED: 'Изменения выключены. Нужны отдельный write-токен и явное включение по SSH.', ADMIN_DISABLED: 'Карточки пользователей выключены в настройках.', ADMIN_STALE: 'Данные изменились после предпросмотра. Создайте новое подтверждение.', ADMIN_CONFIRMATION_EXPIRED: 'Подтверждение использовано или устарело.', ADMIN_BUSY: 'Подождите две секунды и повторите.', ADMIN_FIELD_DISABLED: 'Это поле не разрешено в локальной политике.' };
            return response(messages[error?.message] ?? 'Операция недоступна. При сетевой ошибке изменения не повторяются: сначала проверьте карточку. Формат: «пользователь username»; «измени username description=текст».');
        }
    };
}
