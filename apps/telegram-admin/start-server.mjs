import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConfiguredService } from './configured-service.mjs';
import { createTelegramApi } from '../telegram-client/telegram-api.mjs';
import { readRunOptions, readServerConfig } from './server-config.mjs';
import { runServerBot } from './server-loop.mjs';

const controller = new AbortController();
const stop = () => controller.abort();
let timer;
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
    const options = readRunOptions(process.argv.slice(2));
    const config = readServerConfig(process.env);
    const service = createConfiguredService({ baseUrl: config.baseUrl, tokenFile: config.panelTokenFile, usersEnabled: config.usersEnabled, signal: controller.signal });
    if (statSync(config.telegramTokenFile).size > 4096) throw new Error('INVALID_LOCAL_CREDENTIAL');
    const token = readFileSync(config.telegramTokenFile, 'utf8').trim();
    const apiOptions = { token, allowedUserId: config.allowedUserId, enableButtons: true };
    const api = createTelegramApi({ ...apiOptions, signal: controller.signal });
    const finalApi = createTelegramApi(apiOptions);
    mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
    const offsetFile = join(config.stateDirectory, 'offset.json');
    const heartbeatFile = join(config.stateDirectory, 'heartbeat.json');
    const event = data => process.stdout.write(JSON.stringify({ observedAt: new Date().toISOString(), ...data }) + '\n');
    const result = await runServerBot({
        ...options, api, service, allowedUserId: config.allowedUserId, botUsername: config.botUsername, signal: controller.signal,
        loadOffset: () => {
            try {
                if (statSync(offsetFile).size > 128) throw new Error('INVALID_STATE');
                const data = JSON.parse(readFileSync(offsetFile, 'utf8'));
                if (!data || Object.keys(data).join(',') !== 'offset') throw new Error('INVALID_STATE');
                return data.offset;
            } catch (error) {
                if (error?.code === 'ENOENT') return undefined;
                throw new Error('INVALID_STATE');
            }
        },
        saveOffset: offset => {
            writeFileSync(offsetFile + '.tmp', JSON.stringify({ offset }), { mode: 0o600 });
            renameSync(offsetFile + '.tmp', offsetFile);
        },
        heartbeat: () => writeFileSync(heartbeatFile, JSON.stringify({ observedAt: Date.now() }), { mode: 0o600 }),
        onEvent: event,
        onReady: data => {
            if (!options.continuous) timer = setTimeout(stop, options.seconds * 1000);
            event(data);
        },
        sendFinal: finalApi.sendReply,
    });
    event(result);
    if (result.status === 'failed') process.exitCode = 1;
} catch {
    process.stderr.write('Server bot not started or unavailable. Verify explicit startup approval, configuration and credential files. No private details were printed.\n');
    process.exitCode = 2;
} finally {
    clearTimeout(timer);
    controller.abort();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
}
