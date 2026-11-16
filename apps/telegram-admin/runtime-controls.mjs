import { reportActions } from './intent.mjs';
import { maxDailyAiAttempts } from './intent-store.mjs';

export function readRuntimeControls(env) {
    const limit = env.AI_DAILY_LIMIT === undefined ? String(maxDailyAiAttempts) : env.AI_DAILY_LIMIT;
    if (typeof limit !== 'string' || !/^(?:0|[1-9]\d{0,2})$/.test(limit) || Number(limit) > maxDailyAiAttempts) throw new Error('INVALID_RUNTIME_CONTROLS');
    const permissions = env.PANEL_ALLOWED_REPORTS === undefined ? 'all' : env.PANEL_ALLOWED_REPORTS;
    if (typeof permissions !== 'string') throw new Error('INVALID_RUNTIME_CONTROLS');
    const allowedReports = permissions === 'all' ? [...reportActions] : permissions === 'none' ? [] : permissions.split(',');
    if (new Set(allowedReports).size !== allowedReports.length || allowedReports.some(action => !reportActions.includes(action))) throw new Error('INVALID_RUNTIME_CONTROLS');
    return { dailyLimit: Number(limit), allowedReports };
}

export function applyReportPolicy(service, allowedReports = reportActions) {
    if (!Array.isArray(allowedReports) || allowedReports.some(action => !reportActions.includes(action))) throw new Error('INVALID_RUNTIME_CONTROLS');
    const allowed = new Set(allowedReports);
    return {
        ...service,
        ...Object.fromEntries(reportActions.map(action => [action, async (...args) => {
            if (!allowed.has(action)) throw new Error('REPORT_DISABLED');
            return service[action](...args);
        }])),
    };
}
