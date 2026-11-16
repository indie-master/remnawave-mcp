export function createSquadHandler({ administration, actorId, proposal, now = Date.now }) {
    let view;
    const button = (text, callback_data) => ({ text, callback_data });
    const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    const reply = (text, rows, parent) => ({ text, reply_markup: { inline_keyboard: [...rows, [{ text: '⬅ Назад', callback_data: parent }]] } });
    const requireView = () => {
        if (!view || now() < view.at || now() - view.at >= 600000) throw new Error('ADMIN_SQUADS_EXPIRED');
    };
    const editable = () => administration.canSquadEdit(view.id);
    const list = (kind, page = 0) => {
        const catalog = view[kind];
        const pageCount = Math.max(1, Math.ceil(catalog.length / 8));
        if (!Number.isSafeInteger(page) || page < 0 || page >= pageCount) throw new Error('ADMIN_INVALID_REFERENCE');
        const internal = kind === 'internal';
        const prefix = internal ? 'agi' : 'age';
        const rows = catalog.slice(page * 8, (page + 1) * 8).map((squad, index) => {
            const selected = internal ? view.selected.includes(squad.uuid) : view.externalUuid === squad.uuid;
            return [button(`${selected ? '✓ ' : ''}${squad.name.slice(0, 52)}`, editable() ? `${internal ? 'agt' : 'aget'}:${page * 8 + index}` : `${prefix}:${page}`)];
        });
        const controls = [...(page > 0 ? [button('◀', `${prefix}:${page - 1}`)] : []), ...(page + 1 < pageCount ? [button('▶', `${prefix}:${page + 1}`)] : [])];
        if (controls.length) rows.push(controls);
        if (editable()) rows.push([button('Предпросмотр', internal ? 'agisave' : 'agesave'), ...(!internal ? [button('Без внешнего сквада', 'ageclear')] : [])]);
        return reply(`<b>${internal ? 'Внутренние сквады' : 'Внешний сквад'} · #${view.id}</b>\nСтраница ${page + 1}/${pageCount}\n${editable() ? internal ? 'Отметьте выдаваемые группы. До подтверждения изменения сохраняются только в этом меню.' : 'Можно выбрать один внешний сквад или убрать привязку.' : 'Просмотр назначений.'}`, rows, `ags:${view.id}`);
    };
    return async ({ data }) => {
        if (!/^(?:ags:\d{1,16}|ag[ie]:\d{1,3}|ag(?:t|et):\d{1,3}|agisave|agesave|ageclear)$/.test(data ?? '')) {
            if (data) view = undefined;
            return null;
        }
        let parent = view ? `ags:${view.id}` : 'q:users';
        try {
            if (data.startsWith('ags:')) {
                const id = data.slice(4);
                parent = `au:${id}`;
                view = { ...await administration.squadView(actorId, id), at: now() };
                const names = view.internal.filter(squad => view.selected.includes(squad.uuid)).slice(0, 8).map(squad => escape(squad.name)).join(', ');
                const external = view.external.find(squad => squad.uuid === view.externalUuid);
                return reply(`<b>🔐 Сквады · ${escape(view.username)}</b>\nВнутренних назначено: ${view.selected.length}${names ? `\n${names}` : ''}\nВнешний: ${external ? escape(external.name) : view.externalUuid ? 'нет в доступном списке' : 'не назначен'}`, [[button('Внутренние', 'agi:0'), button('Внешний', 'age:0')], [button('🔄 Обновить', data)]], parent);
            }
            requireView();
            if (data.startsWith('agi:')) return list('internal', Number(data.slice(4)));
            if (data.startsWith('age:')) return list('external', Number(data.slice(4)));
            if (!editable()) throw new Error('ADMIN_ACTION_DISABLED');
            if (data.startsWith('agt:') || data.startsWith('aget:')) {
                const internal = data.startsWith('agt:');
                const index = Number(data.split(':')[1]);
                const squad = view[internal ? 'internal' : 'external'][index];
                if (!squad) throw new Error('ADMIN_INVALID_REFERENCE');
                if (internal) view.selected = view.selected.includes(squad.uuid) ? view.selected.filter(uuid => uuid !== squad.uuid) : [...view.selected, squad.uuid];
                else view.externalUuid = squad.uuid;
                return list(internal ? 'internal' : 'external', Math.floor(index / 8));
            }
            if (data === 'ageclear') { view.externalUuid = null; return list('external'); }
            const changes = data === 'agisave' ? { activeInternalSquads: [...view.selected] } : { externalSquadUuid: view.externalUuid };
            return proposal(await administration.prepareSquads(actorId, String(view.id), changes, view.baseline), parent);
        } catch (error) {
            const messages = { ADMIN_STALE: 'Назначения изменились в панели. Обновите карточку сквадов перед новым выбором.', ADMIN_NO_CHANGE: 'Назначения уже соответствуют выбранным.', ADMIN_ACTION_DISABLED: 'Редактирование сквадов для этого пользователя выключено в настройках.', ADMIN_SQUADS_EXPIRED: 'Меню выбора устарело. Откройте сквады заново.' };
            return reply(messages[error?.message] ?? 'Сквады сейчас недоступны. Проверьте права чтения и записи. Подтверждённые изменения сначала сверьте с панелью.', [], parent);
        }
    };
}
