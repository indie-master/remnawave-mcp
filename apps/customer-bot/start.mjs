import { mkdirSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { createTelegramApi } from '../telegram-client/telegram-api.mjs';
import { createRunSafety, waitForOperator } from '../telegram-admin/run-safety.mjs';
import { readCustomerConfig } from './config.mjs';
import { createCustomerClient } from './gateway-client.mjs';
import { runCustomerBot } from './receiver.mjs';

const controller = new AbortController(); process.once('SIGTERM', () => controller.abort()); process.once('SIGINT', () => controller.abort());
process.umask(0o077);
const event = value => process.stdout.write(JSON.stringify({ observedAt: new Date().toISOString(), ...value }) + '\n');
let safety;
try {
    const config = readCustomerConfig(process.env);
    mkdirSync('/state', { recursive: true, mode: 0o700 }); safety = createRunSafety({ directory: '/state' });
    const heartbeat = phase => writeFileSync('/state/heartbeat.json', JSON.stringify({ observedAt: Date.now(), phase }), { mode: 0o600 });
    if (safety.read().mode === 'paused') { event({ status: 'paused', reason: safety.read().reason, customerBot: true }); heartbeat('paused'); await waitForOperator({ signal: controller.signal, heartbeat: () => heartbeat('paused') }); }
    else {
        if (statSync(config.tokenFile).size > 4096) throw new Error('INVALID_CUSTOMER_CONFIGURATION');
        const token = readFileSync(config.tokenFile, 'utf8').trim();
        const options = { token, enableButtons: true, enableMiniAppButtons: true, signal: controller.signal };
        const polling = createTelegramApi({ ...options, allowedUserId: 1 });
        const api = { getMe: polling.getMe, getWebhookInfo: polling.getWebhookInfo, getUpdates: polling.getUpdates, setMiniAppMenu: polling.setMiniAppMenu, answerCallback: polling.answerCallback, send: (id, text, keyboard) => createTelegramApi({ ...options, allowedUserId: id }).sendReply({ chat_id: id, text, protect_content: true, parse_mode: 'HTML', ...(keyboard ? { reply_markup: keyboard } : {}) }), edit: (id, messageId, text, keyboard) => createTelegramApi({ ...options, allowedUserId: id }).editReply({ chat_id: id, message_id: messageId, text, protect_content: true, parse_mode: 'HTML', ...(keyboard ? { reply_markup: keyboard } : {}) }) };
        const result = await runCustomerBot({ api, config, call: createCustomerClient({ signal: controller.signal }), signal: controller.signal, heartbeat: () => heartbeat('ready'), onEvent: event, sleep: milliseconds => new Promise(resolve => { const timer = setTimeout(done, milliseconds); function done() { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); } controller.signal.addEventListener('abort', done, { once: true }); if (controller.signal.aborted) done(); }),
            loadOffset: () => { try { if (statSync('/state/offset.json').size > 128) throw new Error('INVALID_STATE'); const value = JSON.parse(readFileSync('/state/offset.json', 'utf8')); if (!value || Object.keys(value).join(',') !== 'offset') throw new Error('INVALID_STATE'); return value.offset; } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } },
            saveOffset: offset => { writeFileSync('/state/offset.tmp', JSON.stringify({ offset }), { mode: 0o600 }); renameSync('/state/offset.tmp', '/state/offset.json'); },
        });
        event(result); safety.record(result); if (result.status !== 'stopped') process.exitCode = 2;
    }
} catch { try { safety?.record({ status: 'failed', startedAt: new Date().toISOString(), stoppedAt: new Date().toISOString() }); } catch {} event({ status: 'failed', code: 'CUSTOMER_CONFIGURATION_OR_STATE_UNAVAILABLE' }); process.exitCode = 2; }
