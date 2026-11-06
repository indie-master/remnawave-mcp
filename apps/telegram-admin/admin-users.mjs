import { randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, statSync } from 'node:fs';
import { GetUserByIdCommand, GetUserByUsernameCommand, UpdateUserCommand } from '@remnawave/backend-contract';
import { RemnawaveClient } from '../../dist/client.js';
import { createPanelActions, directoryPageSize, nodeChange, nodeUuidPattern, positiveId } from './admin-panel-actions.mjs';

export const editableFields = ['status', 'expireAt', 'description', 'email', 'telegramId', 'trafficLimitBytes', 'tag', 'hwidDeviceLimit'];
const numericId = value => /^\d{1,16}$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
const reference = value => typeof value === 'string' && (numericId(value) || /^[A-Za-z0-9_-]{3,36}$/.test(value));
const hash = values => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const digest = (target, operation) => operation === 'node-edit'
    ? hash([target.uuid, target.name, target.note, target.updatedAt])
    : hash([target.id, ...editableFields.map(field => target[field] ?? null), ...(operation === 'revoke' ? [target.shortUuid, target.subRevokedAt] : [])]);

function parseUserPatch(body) {
    try { return UpdateUserCommand.RequestBodySchema.parse(body); }
    catch { throw new Error('ADMIN_INVALID_CHANGE'); }
}

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
        ...createPanelActions({ read: (...args) => client(readTokenFile).request(...args), write: (...args) => client(writeTokenFile).request(...args) }),
        async get(ref) {
            if (!reference(ref)) throw new Error('ADMIN_INVALID_REFERENCE');
            const command = numericId(ref) ? GetUserByIdCommand : GetUserByUsernameCommand;
            return client(readTokenFile).request('GET', command.url(numericId(ref) ? Number(ref) : ref));
        },
        async patch(body) { return client(writeTokenFile).request('PATCH', UpdateUserCommand.url, undefined, parseUserPatch(body)); },
    };
}

export function createUserAdministration({ filename, client, actorId, readEnabled = false, writeEnabled = false, allowedFields = ['status', 'expireAt', 'description'], actionUserIds = [], actionNodeUuids = [], nodesEnabled = true, now = Date.now }) {
    if (!Number.isSafeInteger(actorId) || actorId <= 0 || !Array.isArray(allowedFields) || !allowedFields.length || new Set(allowedFields).size !== allowedFields.length || allowedFields.some(field => !editableFields.includes(field)) || (writeEnabled && !readEnabled)) throw new Error('ADMIN_CONFIGURATION_INVALID');
    const database = new DatabaseSync(filename);
    database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS confirmations (id TEXT PRIMARY KEY, actor INTEGER NOT NULL, target TEXT NOT NULL, operation TEXT NOT NULL, payload TEXT NOT NULL, baseline TEXT NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, action TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL);');
    let busy = false;
    const lastRead = new Map();
    let connectionJob;
    function authorize(actor) { if (actor !== actorId || !readEnabled) throw new Error('ADMIN_DISABLED'); }
    async function get(ref) {
        if (!reference(ref)) throw new Error('ADMIN_INVALID_REFERENCE');
        const user = await client.get(ref);
        if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.username !== 'string' || !['ACTIVE', 'DISABLED', 'LIMITED', 'EXPIRED'].includes(user.status)) throw new Error('ADMIN_UNAVAILABLE');
        if (numericId(ref) ? user.id !== Number(ref) : user.username !== ref) throw new Error('ADMIN_UNAVAILABLE');
        return user;
    }
    function ticket(target, operation, payload) {
        const reference = operation === 'node-edit' ? target.uuid : target.id;
        database.prepare('DELETE FROM confirmations WHERE expires < ? AND state != ?').run(now() - 86400000, 'executing');
        database.prepare("UPDATE confirmations SET state = 'expired', payload = '{}' WHERE expires < ? AND state = 'pending'").run(now());
        if (database.prepare('SELECT count(*) AS count FROM confirmations WHERE state = ?').get('pending').count >= 50) throw new Error('ADMIN_BUSY');
        const id = randomBytes(12).toString('base64url');
        database.prepare('INSERT INTO confirmations VALUES (?,?,?,?,?,?,?,?)').run(id, actorId, String(reference), operation, JSON.stringify(payload), digest(target, operation), now() + 180000, 'pending');
        return { id, operation, target: reference, changes: payload, expiresInSeconds: 180, confirmationRequired: true };
    }
    async function exclusive(work, category = 'legacy') {
        if (busy || (['legacy', 'connections'].includes(category) && now() - (lastRead.get(category) ?? -Infinity) < 2000)) throw new Error('ADMIN_BUSY');
        busy = true; lastRead.set(category, now());
        try { return await work(); } finally { busy = false; }
    }
    const canUserAction = id => writeEnabled && actionUserIds.includes(Number(id));
    const canNodeEdit = uuid => nodesEnabled && writeEnabled && actionNodeUuids.includes(uuid);
    function checkNodes() { if (!nodesEnabled) throw new Error('REPORT_DISABLED'); }
    return {
        canUserAction, canNodeEdit,
        policy(actor) { authorize(actor); return { writeEnabled, fields: [...allowedFields] }; },
        hasInFlight(actor) { authorize(actor); return busy; },
        operations(actor) {
            authorize(actor);
            return database.prepare('SELECT id,target,operation,state,expires FROM confirmations WHERE actor=? ORDER BY expires DESC,id DESC LIMIT 20').all(actor).map(entry => ({ ...entry, state: entry.state === 'pending' && entry.expires < now() ? 'expired' : entry.state }));
        },
        async card(actor, ref, navigation = false) {
            authorize(actor);
            return exclusive(async () => {
                const user = await get(ref);
                return { id: user.id, username: user.username, status: user.status, expireAt: user.expireAt, trafficLimitBytes: user.trafficLimitBytes, trafficUsedBytes: user.userTraffic?.usedTrafficBytes ?? null, telegramLinked: user.telegramId != null, description: typeof user.description === 'string' ? user.description.slice(0, 300) : '', hwidDeviceLimit: user.hwidDeviceLimit, observedAt: new Date(now()).toISOString() };
            }, navigation ? 'card' : 'legacy');
        },
        async users(actor, page) { authorize(actor); return exclusive(() => client.users(page), 'directory'); },
        async nodes(actor) { authorize(actor); checkNodes(); return exclusive(() => client.nodes(), 'nodes'); },
        async node(actor, uuid) { authorize(actor); checkNodes(); return exclusive(() => client.node(uuid), 'node'); },
        async devices(actor, id) {
            authorize(actor);
            return exclusive(async () => (await client.devices(id)).map(({ selector, label, createdAt }) => ({ selector, label, createdAt })), 'devices');
        },
        async connections(actor, id, check = false) {
            authorize(actor);
            if (!positiveId(id)) throw new Error('ADMIN_INVALID_REFERENCE');
            return exclusive(async () => {
                const pending = connectionJob && now() >= connectionJob.at && now() - connectionJob.at < 90000;
                if (pending && connectionJob.id !== id) throw new Error('ADMIN_CONNECTIONS_BUSY');
                if (!pending) {
                    if (check) throw new Error('ADMIN_CONNECTIONS_EXPIRED');
                    connectionJob = { id, job: await client.startConnections(id), at: now() };
                    return { pending: true };
                }
                if (!check) return { pending: true };
                const result = await client.connections(id, connectionJob.job);
                if (!result.pending) connectionJob = undefined;
                return result;
            }, 'connections');
        },
        async prepareAction(actor, id, operation, value) {
            authorize(actor);
            if (!positiveId(id) || !canUserAction(id)) throw new Error('ADMIN_ACTION_DISABLED');
            return exclusive(async () => {
                const user = await get(id);
                if (operation === 'revoke' && ['rotate', 'keys'].includes(value) && typeof user.shortUuid === 'string' && user.shortUuid) return ticket(user, operation, { mode: value });
                if (operation === 'device-delete' && /^[A-Za-z0-9_-]{22}$/.test(value)) {
                    const device = (await client.devices(id)).find(item => item.selector === value);
                    if (!device) throw new Error('ADMIN_STALE');
                    return ticket(user, operation, { selector: value, label: device.label });
                }
                throw new Error('ADMIN_INVALID_CHANGE');
            }, 'action');
        },
        async prepareNodeEdit(actor, uuid, field, value) {
            authorize(actor);
            if (!canNodeEdit(uuid)) throw new Error('ADMIN_ACTION_DISABLED');
            const body = nodeChange(uuid, field, value);
            return exclusive(async () => {
                const node = await client.node(uuid);
                if (body[field] === node[field]) throw new Error('ADMIN_NO_CHANGE');
                return ticket(node, 'node-edit', { field, value: body[field], name: node.name });
            }, 'node-edit');
        },
        async prepare(actor, ref, changes, extendOnly = false) {
            authorize(actor);
            if (!writeEnabled) throw new Error('ADMIN_WRITE_DISABLED');
            if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length || Object.keys(changes).some(field => !allowedFields.includes(field))) throw new Error('ADMIN_FIELD_DISABLED');
            if (changes.status !== undefined && !['ACTIVE', 'DISABLED'].includes(changes.status)) throw new Error('ADMIN_INVALID_CHANGE');
            return exclusive(async () => {
                const user = await get(ref);
                const body = parseUserPatch({ id: user.id, ...changes });
                if (extendOnly && !(body.expireAt?.getTime() > Math.max(now(), Date.parse(user.expireAt)))) throw new Error('ADMIN_NOT_EXTENSION');
                const validated = Object.fromEntries(Object.keys(changes).map(field => [field, body[field] instanceof Date ? body[field].toISOString() : body[field]]));
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
                parseUserPatch({ id: user.id, expireAt });
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
            if ((['revoke', 'device-delete'].includes(entry.operation) && !canUserAction(entry.target)) || (entry.operation === 'node-edit' && !canNodeEdit(entry.target))) throw new Error('ADMIN_ACTION_DISABLED');
            const claim = database.prepare('UPDATE confirmations SET state = ? WHERE id = ? AND state = ?').run('executing', id, 'pending');
            if (claim.changes !== 1) throw new Error('ADMIN_CONFIRMATION_EXPIRED');
            busy = true;
            let state = 'rejected';
            try {
                const user = entry.operation === 'node-edit' ? await client.node(entry.target) : await get(entry.target);
                if (digest(user, entry.operation) !== entry.baseline) throw new Error('ADMIN_STALE');
                if (entry.operation === 'subscription') {
                    const url = new URL(user.subscriptionUrl);
                    if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2048) throw new Error('ADMIN_UNAVAILABLE');
                    state = 'done'; return { subscriptionUrl: url.href };
                }
                const changes = JSON.parse(entry.payload);
                if (entry.operation === 'revoke') {
                    state = 'uncertain';
                    await client.revoke(user.id, changes.mode, user.shortUuid);
                    state = 'done'; return { changed: true };
                }
                if (entry.operation === 'device-delete') {
                    const device = (await client.devices(user.id)).find(item => item.selector === changes.selector);
                    if (!device) throw new Error('ADMIN_STALE');
                    state = 'uncertain';
                    await client.deleteDevice(user.id, device.hwid);
                    state = 'done'; return { changed: true };
                }
                if (entry.operation === 'node-edit') {
                    nodeChange(entry.target, changes.field, changes.value);
                    state = 'uncertain';
                    await client.updateNode(entry.target, changes.field, changes.value);
                    state = 'done'; return { changed: true };
                }
                if (entry.operation !== 'patch') throw new Error('ADMIN_INVALID_CHANGE');
                if (Object.keys(changes).some(field => !allowedFields.includes(field))) throw new Error('ADMIN_FIELD_DISABLED');
                const body = { id: user.id, ...changes };
                parseUserPatch(body);
                state = 'uncertain';
                await client.patch(body);
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
    let cardOrigin;
    let nodePage = 0;
    let devicePage;
    let subscriptionTarget;
    let activePreview;
    const escape = value => String(value ?? 'нет данных').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    const button = (text, callback_data) => ({ text, callback_data });
    const back = (data, label = '⬅ Назад') => [button(label, data)];
    const home = back('home', '🏠 Меню');
    const response = (text, rows = [back('admin_menu'), home]) => ({ text, reply_markup: { inline_keyboard: rows } });
    const ticketParent = ticket => ticket.operation === 'node-edit' ? `an:${ticket.target}` : `au:${ticket.target}`;
    const proposal = (ticket, parent = ticketParent(ticket)) => {
        activePreview = { id: ticket.id, parent };
        const description = {
            subscription: () => 'Показать секретную ссылку подписки только в этом чате.',
            revoke: () => ticket.changes.mode === 'keys' ? 'Отозвать и перевыпустить ключи. Ссылка останется прежней, клиенту потребуется обновить подписку.' : 'Отозвать ключи и старую ссылку. Панель выпустит новую ссылку, клиенту потребуется импортировать её заново.',
            'device-delete': () => `Удалить одно устройство: <b>${escape(ticket.changes.label)}</b>. Его слот освободится.`,
            'node-edit': () => `${escape(ticket.changes.name)} · ${ticket.changes.field === 'name' ? 'Новое название' : 'Новая заметка'}: <code>${escape(ticket.changes.value ?? 'очистить')}</code>`,
            patch: () => ticket.changes.expireAt && Object.keys(ticket.changes).length === 1 ? `Новый срок: <b>${moscow(ticket.changes.expireAt)} МСК</b>\n<code>${escape(ticket.changes.expireAt)}</code>` : `Изменения: <code>${escape(JSON.stringify(ticket.changes))}</code>`,
        }[ticket.operation];
        return response(`<b>Подтверждение администратора</b>\n${ticket.operation === 'node-edit' ? 'Нода' : 'Пользователь'}: <code>${escape(ticket.target)}</code>\n${description()}\nДействует 3 минуты. ИИ не может подтвердить действие.`, [[button('✅ Подтвердить', `ac:${ticket.id}`), button('⬅ Назад / отменить', `ax:${ticket.id}`)]]);
    };
    const policy = () => administration.policy?.(actorId) ?? { writeEnabled: false, fields: [] };
    const navigation = [[button('📋 Список пользователей', 'aul:0'), button('🔎 Найти пользователя', 'admin_search')], [button('🗒 Операции', 'admin_operations')], back('q:users'), home];
    const moscow = value => Number.isFinite(new Date(value ?? NaN).getTime()) ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : 'нет данных';
    function paging(page, total, callback) {
        const controls = [];
        if (page > 0) controls.push(button('◀ Пред.', callback(page - 1)));
        if (page + 1 < Math.ceil(total / directoryPageSize)) controls.push(button('След. ▶', callback(page + 1)));
        return controls.length ? [controls] : [];
    }
    const labels = { status: 'Статус', expireAt: 'Окончание подписки', description: 'Описание', email: 'Почта', telegramId: 'Telegram ID', trafficLimitBytes: 'Лимит трафика в байтах', tag: 'Метка', hwidDeviceLimit: 'Лимит устройств' };
    const card = async (ref, page) => {
        const user = await administration.card(actorId, ref, true);
        subscriptionTarget = undefined;
        cardOrigin = { id: user.id, page: page ?? (cardOrigin?.id === user.id && cardOrigin.page) };
        const parent = Number.isInteger(cardOrigin.page) ? `aul:${cardOrigin.page}` : 'q:users';
        const permissions = policy();
        const rows = [[button('🔗 Подписка', `as:${user.id}`)], [button('📱 Устройства', `ah:${user.id}:0`), button('🔌 Соединения', `aj:${user.id}:start`)]];
        if (permissions.writeEnabled && permissions.fields.includes('expireAt')) rows.push([{ text: '⏳ Продлить', callback_data: `ar:${user.id}` }]);
        if (permissions.writeEnabled && permissions.fields.length) rows.push([{ text: '✏️ Изменить данные', callback_data: `av:${user.id}` }]);
        if (permissions.writeEnabled && permissions.fields.includes('status')) rows.push([{ text: 'Включить', callback_data: `ae:${user.id}` }, { text: 'Отключить', callback_data: `ad:${user.id}` }]);
        rows.push([button('🔄 Обновить', `au:${user.id}`), button('🔎 Другой пользователь', 'admin_search')], back(parent), home);
        return response(`<b>👤 ${escape(user.username)}</b>\nID: <code>${escape(user.id)}</code>\nСтатус: ${escape(user.status)}\nДо: ${moscow(user.expireAt)} МСК\nТрафик: ${escape(user.trafficUsedBytes)} / ${escape(user.trafficLimitBytes)} байт\nЛимит HWID: ${user.hwidDeviceLimit ?? 'по настройкам панели'}\nTelegram: ${user.telegramLinked ? 'привязан' : 'не привязан'}\nОписание: ${escape(user.description)}\nПроверено: ${moscow(user.observedAt)} МСК`, rows);
    };
    function manualDate(text) {
        const match = text.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/);
        if (!match) return text;
        const [, day, month, year, hour, minute] = match;
        const localTime = `${year}-${month}-${day}T${hour}:${minute}:00`;
        const stamp = Date.parse(localTime + 'Z');
        if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 19) !== localTime) throw new Error('ADMIN_INVALID_CHANGE');
        return localTime + '+03:00';
    }
    const handle = async ({ text = '', data, allowedUserId }) => {
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
        const interactive = /^(?:admin_home|admin_menu|admin_search|admin_cancel_input|admin_operations|a(?:r|v|s|rs|dt|hl):\d{1,16}|ap:\d{1,16}:\d{1,3}|af:\d{1,16}:[A-Za-z]+|aul:\d{1,16}|alc:\d{1,16}:\d{1,16}|ah:\d{1,16}:\d{1,10}|ahd:\d{1,16}:[A-Za-z0-9_-]{22}|ak:\d{1,16}:(?:rotate|keys)|aj:\d{1,16}:(?:start|check)|anl:\d{1,4}|a(?:n|nm):[0-9a-f-]{36}|anf:[0-9a-f-]{36}:(?:name|note))$/.test(data ?? '');
        const inactiveReference = !data && !input && userSection && reference(text.trim());
        if (!match && !edit && !subscription && !pending && !renewal && !statusChange && !input && !interactive && !inactiveReference && !/^(?:ac:|ax:|al:|au:|ad:|ae:)/.test(data ?? '') && !/^(?:пользователь|юзер|user|измени|изменить|подписка|ссылка подписки|заявка|продли|продлить|включи|отключи)(?:\s|$)/i.test(text)) { userSection = false; return null; }
        let failureBack = 'admin_menu';
        try {
            userSection = true;
            if (data === 'admin_menu') return response('<b>👥 Пользователи</b>\nОткройте свежий список или найдите пользователя по точному ID или username.', [[button('📋 Список пользователей', 'aul:0'), button('🔎 Найти пользователя', 'admin_search')], [button('📊 Сводка', 'q:users'), button('🗒 Операции', 'admin_operations')], back('stats_menu'), home]);
            if (data === 'admin_home' || data === 'admin_search') { input = { kind: 'search', at: now() }; cardOrigin = undefined; return response('<b>Поиск пользователя</b>\nВведите точный числовой ID или username без дополнительных слов. Ввод действует 2 минуты; похожие имена не подбираются. ИИ не используется.', [[button('⬅ Назад / отменить', 'admin_cancel_input'), button('🗒 Операции', 'admin_operations')], home]); }
            if (data === 'admin_cancel_input') return response('Ввод отменён. Панель не изменялась.', navigation);
            if (data === 'admin_operations') {
                const entries = administration.operations?.(actorId) ?? [];
                return response('<b>Последние сохранённые операции</b>\n' + (entries.length ? entries.map(entry => `#${escape(entry.target)} · ${escape(entry.operation)} · ${escape(entry.state)}\n<code>${escape(entry.id)}</code>`).join('\n\n') : 'Операций пока нет.') + '\n\nexecuting / uncertain требуют проверки, а не повторной отправки. Полезная нагрузка и секретные ссылки не показываются.', navigation);
            }
            const [route, target, argument] = (data ?? '').split(':');
            if (route === 'aul') {
                const page = Number(target);
                const { users, total } = await administration.users(actorId, page);
                const lastPage = Math.max(0, Math.ceil(total / directoryPageSize) - 1);
                if (page > lastPage) return response('Список изменился. Откройте последнюю доступную страницу.', [back(`aul:${lastPage}`, 'К списку'), back('admin_menu')]);
                return response(`<b>👥 Все пользователи</b>\nВсего: ${total} · страница ${page + 1}/${lastPage + 1}\nВыберите карточку. Список обновляется при открытии каждой страницы.`, [
                    ...users.map(user => [button(`#${user.id} · ${user.username} · ${user.status}`, `alc:${user.id}:${page}`)]), ...paging(page, total, next => `aul:${next}`),
                    [button('🔄 Обновить', `aul:${page}`), button('🔎 Поиск', 'admin_search')], back('q:users'), home,
                ]);
            }
            if (route === 'alc') { failureBack = `aul:${argument}`; return await card(target, Number(argument)); }
            if (route === 'as' || route === 'ars') {
                failureBack = `au:${target}`;
                const user = await administration.card(actorId, target, true);
                subscriptionTarget = target;
                if (route === 'ars') {
                    if (!administration.canUserAction(target)) throw new Error('ADMIN_ACTION_DISABLED');
                    return response(`<b>Отзыв подписки · ${escape(user.username)}</b>\nОба режима меняют ключи подключения. Выберите, нужно ли также сменить ссылку.`, [[button('🔁 Ключи и новая ссылка', `ak:${target}:rotate`)], [button('🔑 Только ключи', `ak:${target}:keys`)], back(`as:${target}`)]);
                }
                const permissions = policy();
                return response(`<b>🔗 Подписка · ${escape(user.username)}</b>\nСтатус: ${escape(user.status)}\nОкончание: ${moscow(user.expireAt)} МСК`, [
                    [button('Показать ссылку', `al:${target}`)],
                    ...(permissions.writeEnabled && permissions.fields.includes('expireAt') ? [[button('⏳ Продлить', `ar:${target}`)]] : []),
                    ...(administration.canUserAction(target) ? [[button('🔁 Отозвать / перевыпустить', `ars:${target}`)]] : []),
                    back(`au:${target}`), home,
                ]);
            }
            if (route === 'ak') { failureBack = `ars:${target}`; return proposal(await administration.prepareAction(actorId, target, 'revoke', argument), failureBack); }
            if (route === 'ah' || route === 'ahd') {
                failureBack = `au:${target}`;
                if (route === 'ahd') { failureBack = `ah:${target}:${devicePage?.target === target ? devicePage.page : 0}`; return proposal(await administration.prepareAction(actorId, target, 'device-delete', argument), failureBack); }
                const page = Number(argument);
                const devices = await administration.devices(actorId, target);
                const lastPage = Math.max(0, Math.ceil(devices.length / directoryPageSize) - 1);
                if (page > lastPage) return response('Список устройств изменился.', [back(`ah:${target}:${lastPage}`, 'К устройствам'), back(`au:${target}`)]);
                devicePage = { target, page };
                const visible = devices.slice(page * directoryPageSize, (page + 1) * directoryPageSize);
                const permissions = policy();
                return response(`<b>📱 Устройства · #${target}</b>\nЗарегистрировано: ${devices.length} · страница ${page + 1}/${lastPage + 1}` + visible.map((device, index) => `\n${page * directoryPageSize + index + 1}. ${escape(device.label.slice(0, 60))} · добавлено ${moscow(device.createdAt)} МСК`).join(''), [
                    ...(administration.canUserAction(target) ? visible.map((device, index) => [button(`Удалить №${page * directoryPageSize + index + 1} · ${device.label.slice(0, 32)}`, `ahd:${target}:${device.selector}`)]) : []),
                    ...paging(page, devices.length, next => `ah:${target}:${next}`),
                    ...(permissions.writeEnabled && permissions.fields.includes('hwidDeviceLimit') ? [[button('Изменить лимит HWID', `ahl:${target}`)]] : []),
                    [button('🔄 Обновить', `ah:${target}:${page}`)], back(`au:${target}`), home,
                ]);
            }
            if (route === 'aj') {
                failureBack = `au:${target}`;
                const result = await administration.connections(actorId, target, argument === 'check');
                if (result.pending) return response('Панель опрашивает ноды. Нажмите «Проверить результат» через несколько секунд.', [[button('🔄 Проверить результат', `aj:${target}:check`)], back(`au:${target}`)]);
                const visible = result.nodes.slice(0, 10);
                return response(`<b>🔌 Соединения · #${target}</b>\n${visible.length ? visible.map(node => `${escape(node.name.slice(0, 45))} · адресов: ${node.count} · последнее наблюдение: ${moscow(node.lastSeen)} МСК`).join('\n') : 'В ответе панели активных соединений нет.'}${visible.length < result.nodes.length ? `\nПоказано ${visible.length} из ${result.nodes.length} нод.` : ''}`, [[button('🔄 Запросить заново', `aj:${target}:start`)], back(`au:${target}`)]);
            }
            if (route === 'anl' || route === 'an' || route === 'anm' || route === 'anf') {
                failureBack = 'q:nodes';
                if (route === 'anl') {
                    const nodes = await administration.nodes(actorId);
                    nodePage = Math.min(Number(target), Math.max(0, Math.ceil(nodes.length / directoryPageSize) - 1));
                    return response(`<b>🖥 Список нод</b>\nВсего: ${nodes.length} · страница ${nodePage + 1}/${Math.max(1, Math.ceil(nodes.length / directoryPageSize))}`, [
                        ...nodes.slice(nodePage * directoryPageSize, (nodePage + 1) * directoryPageSize).map(node => [button(`${node.name.slice(0, 44)} · ${node.state}`, `an:${node.uuid}`)]),
                        ...paging(nodePage, nodes.length, next => `anl:${next}`), [button('🔄 Обновить', `anl:${nodePage}`)], back('q:nodes'), home,
                    ]);
                }
                failureBack = `anl:${nodePage}`;
                if (route === 'anf') {
                    if (!administration.canNodeEdit(target)) throw new Error('ADMIN_ACTION_DISABLED');
                    input = { kind: 'node', target, field: argument, at: now() };
                    return response(argument === 'name' ? 'Введите новое название ноды, от 3 до 30 символов.' : 'Введите заметку до 255 символов. Чтобы очистить, отправьте один дефис «-».', [back(`anm:${target}`)]);
                }
                const node = await administration.node(actorId, target);
                if (route === 'anm') {
                    if (!administration.canNodeEdit(target)) throw new Error('ADMIN_ACTION_DISABLED');
                    return response(`<b>Изменить · ${escape(node.name)}</b>\nДоступны название и заметка. Для записи потребуется подтверждение.`, [[button('Название', `anf:${target}:name`), button('Заметка', `anf:${target}:note`)], back(`an:${target}`)]);
                }
                return response(`<b>🖥 ${escape(node.name)}</b>\nСостояние: ${escape(node.state)}\nОнлайн: ${escape(node.online)}\nСтрана: ${escape(node.country)}\nТрафик: ${escape(node.trafficUsed)} / ${escape(node.trafficLimit)} байт\nЗаметка: ${escape(node.note)}\nПроверено: ${moscow(now())} МСК`, [
                    ...(administration.canNodeEdit(target) ? [[button('✏️ Изменить', `anm:${target}`)]] : []), [button('🔄 Обновить', `an:${target}`)], back(`anl:${nodePage}`), home,
                ]);
            }
            const renewPreset = data?.match(/^ap:(\d{1,16}):(\d{1,3})$/);
            if (renewPreset) {
                failureBack = `ar:${renewPreset[1]}`;
                if (!renewalDays.includes(Number(renewPreset[2]))) throw new Error('ADMIN_INVALID_CHANGE');
                return proposal(await administration.prepareRenewal(actorId, renewPreset[1], Number(renewPreset[2])), failureBack);
            }
            const renewMenu = data?.match(/^ar:(\d{1,16})$/);
            if (renewMenu) {
                if (!policy().writeEnabled || !policy().fields.includes('expireAt')) throw new Error('ADMIN_WRITE_DISABLED');
                const parent = subscriptionTarget === target ? `as:${target}` : `au:${target}`;
                return response('Выберите срок. После выбора откроется предпросмотр новой даты.', [...renewalDays.map(days => [button(`+${days} дн.`, `ap:${target}:${days}`)]), [button('📅 Ввести дату вручную', `adt:${target}`)], back(parent)]);
            }
            const fieldsMenu = data?.match(/^av:(\d{1,16})$/);
            if (fieldsMenu) {
                if (!policy().writeEnabled) throw new Error('ADMIN_WRITE_DISABLED');
                return response('Выберите разрешённое поле. Значение будет проверено по контракту панели, затем потребуется подтверждение.', [...policy().fields.map(field => [button(labels[field], `af:${fieldsMenu[1]}:${field}`)]), back(`au:${fieldsMenu[1]}`)]);
            }
            const fieldInput = route === 'adt' ? [data, target, 'expireAt'] : route === 'ahl' ? [data, target, 'hwidDeviceLimit'] : data?.match(/^af:(\d{1,16}):([A-Za-z]+)$/);
            if (fieldInput) {
                if (!policy().writeEnabled || !policy().fields.includes(fieldInput[2])) throw new Error('ADMIN_FIELD_DISABLED');
                const parent = route === 'adt' ? `ar:${target}` : route === 'ahl' ? `ah:${target}:${devicePage?.target === target ? devicePage.page : 0}` : `av:${target}`;
                input = { kind: route === 'adt' ? 'date' : 'field', target: fieldInput[1], field: fieldInput[2], parent, at: now() };
                const help = fieldInput[2] === 'expireAt' ? 'Формат: ДД.ММ.ГГГГ ЧЧ:ММ по Москве или ISO 8601 с часовым поясом.' : fieldInput[2] === 'status' ? 'Допустимые значения: ACTIVE и DISABLED.' : ['trafficLimitBytes', 'hwidDeviceLimit', 'telegramId'].includes(fieldInput[2]) ? 'Введите целое число.' : '';
                return response(`Введите новое значение: ${escape(labels[fieldInput[2]])}.\n${help}\nВвод действует 2 минуты.`, [back(parent)]);
            }
            if (inactiveReference && !match && !edit && !subscription && !pending && !renewal && !statusChange) return response('Для поиска нажмите «Найти пользователя» и отправьте ID или username после приглашения. Панель и ИИ не запрашивались; число не считается периодом подписки.', navigation);
            if (!data && input && !match && !edit && !subscription && !pending && !renewal && !statusChange) {
                const value = input; input = undefined;
                failureBack = value.parent ?? (value.kind === 'node' ? `anm:${value.target}` : 'admin_menu');
                if (now() < value.at || now() - value.at >= 120000) return response('Время ввода истекло. Откройте действие заново.', value.kind === 'search' ? navigation : [back(failureBack), home]);
                if (value.kind === 'search') {
                    if (!reference(text.trim())) return response('Нужен точный ID или username; панель и ИИ не запрашивались.', navigation);
                    return await card(text.trim());
                }
                if (!text.length || text.length > 500) throw new Error('ADMIN_INVALID_CHANGE');
                if (value.kind === 'node') return proposal(await administration.prepareNodeEdit(actorId, value.target, value.field, value.field === 'note' && text === '-' ? null : text), failureBack);
                let converted = text;
                if (['trafficLimitBytes', 'hwidDeviceLimit', 'telegramId'].includes(value.field)) {
                    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error('ADMIN_INVALID_CHANGE');
                    converted = Number(text);
                }
                if (value.field === 'expireAt') {
                    converted = manualDate(text);
                    if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(converted) || !(Date.parse(converted) > now())) throw new Error('ADMIN_INVALID_CHANGE');
                }
                return proposal(await administration.prepare(actorId, value.target, { [value.field]: converted }, value.kind === 'date'), failureBack);
            }
            if (priorInput && (match || edit || subscription || pending || renewal || statusChange)) input = undefined;
            if (pending) return proposal(administration.preview(actorId, pending[1]));
            if (renewal) return proposal(await administration.prepareRenewal(actorId, renewal[1], Number(renewal[2])));
            if (statusChange) return proposal(await administration.prepare(actorId, statusChange[2], { status: statusChange[1].toLowerCase() === 'включи' ? 'ACTIVE' : 'DISABLED' }));
            if (data?.startsWith('ac:')) {
                const ticket = administration.preview(actorId, data.slice(3));
                failureBack = ticketParent(ticket);
                const result = await administration.confirm(actorId, data.slice(3));
                const parent = ticket.operation === 'subscription' || ticket.operation === 'revoke' ? `as:${ticket.target}` : ticket.operation === 'device-delete' ? `ah:${ticket.target}:${devicePage?.target === ticket.target ? devicePage.page : 0}` : failureBack;
                return response(result.subscriptionUrl ? `<b>Ссылка подписки — не пересылайте её</b>\n<code>${escape(result.subscriptionUrl)}</code>` : '✅ Изменение подтверждено панелью.', [back(parent), home]);
            }
            if (data?.startsWith('ax:')) {
                const ticket = administration.preview(actorId, data.slice(3));
                administration.cancel(actorId, data.slice(3));
                const parent = activePreview?.id === ticket.id ? activePreview.parent : ticketParent(ticket);
                activePreview = undefined;
                return await handle({ data: parent, allowedUserId });
            }
            if (subscription || data?.startsWith('al:')) {
                const ticket = await administration.prepareSubscription(actorId, subscription?.[1] ?? target);
                return proposal(ticket, `as:${ticket.target}`);
            }
            if (edit) {
                const field = edit[2];
                const value = ['trafficLimitBytes', 'hwidDeviceLimit', 'telegramId'].includes(field) ? Number(edit[3]) : edit[3];
                return proposal(await administration.prepare(actorId, edit[1], { [field]: value }));
            }
            if (/^a[de]:/.test(data ?? '')) return proposal(await administration.prepare(actorId, data.slice(3), { status: data.startsWith('ae:') ? 'ACTIVE' : 'DISABLED' }));
            return await card(match?.[1] ?? data?.slice(3));
        } catch (error) {
            const messages = {
                ADMIN_WRITE_DISABLED: 'Изменения выключены. Нужны отдельный write-токен и явное включение по SSH.',
                ADMIN_DISABLED: 'Карточки пользователей выключены в настройках.',
                ADMIN_STALE: 'Данные изменились после предпросмотра. Создайте новое подтверждение.',
                ADMIN_CONFIRMATION_EXPIRED: 'Подтверждение использовано или устарело.',
                ADMIN_BUSY: 'Подождите две секунды и повторите.',
                ADMIN_FIELD_DISABLED: 'Это поле не разрешено в локальной политике.',
                ADMIN_INVALID_CHANGE: 'Значение некорректно или дата уже прошла. Запрос изменения к панели не отправлялся.',
                ADMIN_NOT_EXTENSION: 'Для продления выберите дату позже текущего окончания подписки.',
                ADMIN_ACTION_DISABLED: 'Действие выключено для этой карточки. Разрешения задаются в настройках бота.',
                ADMIN_NO_CHANGE: 'Такое значение уже установлено.',
                ADMIN_CONNECTIONS_BUSY: 'Панель ещё проверяет соединения другого пользователя. Вернитесь к нему или дождитесь окончания запроса.',
                ADMIN_CONNECTIONS_EXPIRED: 'Запрос устарел. Откройте соединения пользователя заново.',
                REPORT_DISABLED: 'Этот раздел отключён в разрешениях бота.',
            };
            const unavailable = [401, 403].includes(error?.status) ? 'Панель отклонила доступ. Проверьте права токена для этой операции.' : error?.status === 404 ? 'Запись не найдена в панели. Обновите список.' : 'Операция недоступна. Если вы уже подтвердили изменение, сначала проверьте карточку или журнал операций.';
            return response(messages[error?.message] ?? unavailable, [back(failureBack), home]);
        }
    };
    return handle;
}
