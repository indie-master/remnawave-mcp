const bytes = value => {
    return `${(value / 1073741824).toFixed(2)} ГБ`;
};
const states = { online: '🟢 Онлайн', offline: '🔴 Офлайн', disabled: '⚪ Отключена', connecting: '🟡 Подключается' };

export function extraView(action, report, page = 0) {
    if (action === 'users') return ['<b>👥 Пользователи</b>', `Всего: <b>${report.totalUsers}</b>`, `Активные: ${report.statuses.ACTIVE}`, `Отключённые: ${report.statuses.DISABLED}`, `Лимит трафика исчерпан: ${report.statuses.LIMITED}`, `Подписка истекла: ${report.statuses.EXPIRED}`];
    if (action === 'online') return ['<b>🟢 Пользователи онлайн</b>', `Сейчас: <b>${report.onlineNow}</b>`, `За последние сутки: ${report.lastDay}`, `За последнюю неделю: ${report.lastWeek}`, `Никогда не подключались: ${report.neverOnline}`, `Всего зарегистрировано: ${report.totalUsers}`, '\nПериоды пересекаются; показатели не нужно складывать.'];
    if (action === 'system') return ['<b>⚙️ Ресурсы панели</b>', `Ядер: ${report.cores}`, `Память: ${bytes(report.memoryUsed)} / ${bytes(report.memoryTotal)}`, `Свободно: ${bytes(report.memoryFree)}`, `Uptime: ${(report.uptimeSeconds / 3600).toFixed(1)} ч.`, '\nМетрики сообщает панель; это не проверка Docker-хоста.'];
    if (action === 'hosts') return ['<b>🌐 Хосты</b>', `Всего: ${report.total}`, `Включены: ${report.enabled}`, `Отключены: ${report.disabled}`, '\nВключённый хост не означает проверенную сетевую доступность.'];
    if (['profiles', 'internal_squads', 'external_squads'].includes(action)) return [`<b>${({ profiles: '🗂 Профили конфигурации', internal_squads: '🔹 Внутренние сквады', external_squads: '🔸 Внешние сквады' })[action]}</b>`, `Всего: ${report.total}`, '\nКонфигурации, ключи и адреса не выводятся.'];
    if (action === 'bandwidth') return ['<b>📈 Трафик панели</b>', ...Object.entries({ bandwidthLastTwoDays: 'Сегодня', bandwidthLastSevenDays: 'Семь дней', bandwidthLast30Days: '30 дней', bandwidthCalendarMonth: 'Календарный месяц', bandwidthCurrentYear: 'Текущий год' }).map(([key, label]) => `${label}: ${report.periods[key].current}`), '\nЕдиницы сохранены из API, периоды пересекаются. Детализация по конкретной ноде здесь не представлена. Нулевое значение API само по себе не доказывает отсутствие трафика.'];
    if (action === 'health') return ['<b>🩺 Процессы панели</b>', `Процессов в ответе: ${report.processes.length}`, ...report.processes.slice(0, 5).map((process, index) => `#${index + 1}: RSS ${bytes(process.rssBytes)}, uptime ${(process.uptimeSeconds / 3600).toFixed(1)} ч., event loop ${process.eventLoopDelayMs.toFixed(1)} мс`), ...(report.processes.length > 5 ? ['Показаны первые пять процессов.'] : []), '\nЭто метрики runtime, не гарантия здоровья всех зависимостей.'];
    if (action === 'node_details') {
        const pages = Math.max(1, Math.ceil(report.nodes.length / 5));
        if (!Number.isSafeInteger(page) || page < 0 || page >= pages) throw new Error('INVALID_PAGE');
        return ['<b>🖥 Ноды: подробности</b>', `Всего: ${report.total} · страница ${page + 1}/${pages}`, ...report.nodes.slice(page * 5, page * 5 + 5).map(node => `\nНода #${node.reference}: ${states[node.state]}\nПользователей онлайн: ${node.usersOnline === null ? 'нет данных' : node.usersOnline}`), '\nНомера относятся только к этому снимку. Сумма подключений нод не равна числу уникальных пользователей.'];
    }
    return null;
}
