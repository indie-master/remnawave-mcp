import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const reasons = ['RECEIVER_CONFLICT', 'WEBHOOK_BLOCKED', 'BOT_IDENTITY_MISMATCH', 'INVALID_STATE', 'REPEATED_STARTUP_FAILURE', 'SAFETY_STATE_UNAVAILABLE'];

export function createRunSafety({ directory, now = Date.now }) {
    const filename = join(directory, 'receiver-safety.json');
    const write = value => { writeFileSync(filename + '.tmp', JSON.stringify(value), { mode: 0o600 }); renameSync(filename + '.tmp', filename); };
    const read = () => {
        try {
            if (statSync(filename).size > 512) throw new Error('INVALID_STATE');
            const value = JSON.parse(readFileSync(filename, 'utf8'));
            if (!['active', 'paused'].includes(value.mode) || !Number.isSafeInteger(value.failures) || value.failures < 0 || value.failures > 5 || !Number.isSafeInteger(value.lastFailure) || (value.mode === 'paused' && !reasons.includes(value.reason))) throw new Error('INVALID_STATE');
            return value;
        } catch (error) {
            if (error?.code === 'ENOENT') return { mode: 'active', failures: 0, lastFailure: 0 };
            return { mode: 'paused', reason: 'SAFETY_STATE_UNAVAILABLE', failures: 5, lastFailure: now() };
        }
    };
    return {
        read,
        record: result => {
            const state = read();
            if (state.mode === 'paused') return state;
            if (result.status === 'blocked') {
                const value = { mode: 'paused', reason: reasons.includes(result.reason) ? result.reason : 'SAFETY_STATE_UNAVAILABLE', failures: 5, lastFailure: now() };
                write(value); return value;
            }
            if (result.status === 'failed') {
                const duration = Date.parse(result.stoppedAt) - Date.parse(result.startedAt);
                const failures = state.lastFailure && now() - state.lastFailure < 900000 && !(duration >= 60000) ? Math.min(5, state.failures + 1) : 1;
                const value = { mode: failures >= 5 ? 'paused' : 'active', failures, lastFailure: now(), ...(failures >= 5 ? { reason: 'REPEATED_STARTUP_FAILURE' } : {}) };
                write(value); return value;
            }
            write({ mode: 'active', failures: 0, lastFailure: 0 });
            return read();
        },
        acknowledge: () => write({ mode: 'active', failures: 0, lastFailure: 0 }),
    };
}

export async function waitForOperator({ signal, heartbeat }) {
    if (signal.aborted) return;
    await new Promise(resolve => {
        const timer = setInterval(() => { try { heartbeat(); } catch {} }, 30000);
        const stop = () => { clearInterval(timer); signal.removeEventListener('abort', stop); resolve(); };
        signal.addEventListener('abort', stop, { once: true });
    });
}
