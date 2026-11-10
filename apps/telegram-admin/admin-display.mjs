const gibibyte = 1024 ** 3;
const moscowOffset = 3 * 3600000;
export const statusLabels = { ACTIVE: 'Активен', DISABLED: 'Отключён', LIMITED: 'Лимит исчерпан', EXPIRED: 'Истёк' };
export const trafficStrategies = { NO_RESET: 'Без сброса', DAY: 'Ежедневно', WEEK: 'Еженедельно', MONTH: 'Ежемесячно', MONTH_ROLLING: 'Скользящий месяц' };

export function formatTraffic(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return 'нет данных';
    if (bytes === 0) return '0 МБ';
    if (bytes < 1024) return 'менее 1 КБ';
    const [divisor, unit] = [[1024 ** 4, 'ТБ'], [gibibyte, 'ГБ'], [1024 ** 2, 'МБ'], [1024, 'КБ']].find(([minimum]) => bytes >= minimum);
    return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(bytes / divisor)} ${unit}`;
}

export const formatLimit = value => value === 0 ? 'без лимита' : formatTraffic(value);

export function parseGigabytes(text) {
    const input = text.trim().match(/^(\d{1,8})(?:[.,](\d{1,3}))?(?:\s*гб)?$/i);
    if (!input) throw new Error('ADMIN_INVALID_CHANGE');
    const whole = Number(input[1]);
    const thousandths = Number((input[2] ?? '').padEnd(3, '0'));
    const bytes = whole * gibibyte + Math.round(thousandths * gibibyte / 1000);
    if (!Number.isSafeInteger(bytes)) throw new Error('ADMIN_INVALID_CHANGE');
    return bytes;
}

export const moscowDate = value => Number.isFinite(new Date(value ?? NaN).getTime()) ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : 'нет данных';

export function addMoscowMonths(from, months) {
    const local = new Date(from + moscowOffset);
    const day = local.getUTCDate();
    local.setUTCDate(1);
    local.setUTCMonth(local.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0)).getUTCDate();
    local.setUTCDate(Math.min(day, lastDay));
    return new Date(local.getTime() - moscowOffset).toISOString();
}

export function calendarMonth(stamp) {
    const local = new Date(stamp + moscowOffset);
    return local.getUTCFullYear() * 12 + local.getUTCMonth();
}

export function calendarExpiry(monthIndex, day) {
    const year = Math.floor(monthIndex / 12);
    const month = monthIndex % 12;
    const timestamp = Date.UTC(year, month, day, 20, 59);
    if (new Date(timestamp).getUTCDate() !== day) throw new Error('ADMIN_INVALID_CHANGE');
    return new Date(timestamp).toISOString();
}
