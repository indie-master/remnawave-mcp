const transient = ['NETWORK_FAILED', 'TELEGRAM_TEMPORARY_UNAVAILABLE', 'TELEGRAM_RATE_LIMIT', 'CUSTOMER_NETWORK_FAILED'];
const causes = [...transient, 'TELEGRAM_REQUEST_FAILED', 'TELEGRAM_RESPONSE_INVALID', 'TELEGRAM_RESPONSE_TOO_LARGE', 'CUSTOMER_UNAVAILABLE', 'BOT_IDENTITY_MISMATCH', 'WEBHOOK_BLOCKED', 'RECEIVER_CONFLICT', 'INVALID_STATE', 'INVALID_UPDATES', 'INVALID_SERVER_CONFIGURATION', 'INVALID_LOCAL_CREDENTIAL', 'INVALID_CUSTOMER_CONFIGURATION', 'EACCES', 'ENOENT', 'ENOSPC', 'EROFS', 'ERR_SQLITE_ERROR', 'REPLY_BLOCKED'];
export const transientReadError = error => transient.includes(error?.code ?? error?.message);
export const receiverCause = error => { const code = error?.code ?? error?.message; return causes.includes(code) ? code : 'INITIALIZATION_OR_RUNTIME_FAILED'; };
export const uncertainDelivery = error => transientReadError(error) || ['TELEGRAM_REQUEST_FAILED', 'TELEGRAM_RESPONSE_INVALID', 'TELEGRAM_RESPONSE_TOO_LARGE'].includes(error?.code);

// Use only for idempotent reads and identity registration, never for Telegram sends or panel writes.
export function createReadRetry({ signal, sleep, heartbeat = () => {}, onEvent = () => {} }) {
    return async (operation, phase) => {
        let failures = 0;
        while (!signal?.aborted) {
            try {
                const value = await operation();
                if (failures) onEvent({ event: 'connection', ok: true, phase });
                return value;
            } catch (error) {
                if (signal?.aborted || !transientReadError(error)) throw error;
                const requested = Number.isInteger(error.retryAfter) ? error.retryAfter * 1000 : 0;
                const delay = Math.min(300000, Math.max(Math.min(60000, 2000 * 2 ** Math.min(failures++, 5)), requested));
                onEvent({ event: 'connection', ok: false, phase, code: receiverCause(error), retryInSeconds: delay / 1000 });
                for (let remaining = delay; remaining > 0 && !signal?.aborted; remaining -= 30000) {
                    heartbeat('reconnecting'); await sleep(Math.min(remaining, 30000), signal);
                }
            }
        }
        throw new Error('STOP_REQUESTED');
    };
}
