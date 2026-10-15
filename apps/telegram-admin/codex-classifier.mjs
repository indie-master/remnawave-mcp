import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { normalizeQuestion } from './intent-store.mjs';
import { validateIntent } from './intent.mjs';

export const codexVersion = '0.162.1';
export const classifierModel = 'gpt-6-luna';
const directory = fileURLToPath(new URL('./', import.meta.url));
export const disabledFeatures = ['shell_tool', 'unified_exec', 'plugins', 'apps', 'remote_plugin', 'multi_agent', 'multi_agent_v2', 'hooks', 'goals', 'memories', 'shell_snapshot', 'code_mode_host', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'artifact', 'in_app_browser', 'in_app_chat', 'in_app_local_automation', 'skill_search', 'skill_mcp_dependency_install', 'workspace_dependencies', 'tool_suggest', 'view_image', 'sleep_tool', 'recommended_plugins', 'request_permissions_tool', 'unbounded_connection_retries', 'daemon_auto_start', 'fast_mode', 'ultrafast_mode'];

export function guardClassifierEvent(line) {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error('AI_UNAVAILABLE'); }
    if (String(event?.type).startsWith('item.') && !['reasoning', 'agent_message'].includes(event.item?.type)) throw new Error('AI_TOOL_ATTEMPT');
    return event;
}

export function classifierArguments() {
    return ['--no-daemon', 'exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', 'read-only',
        ...disabledFeatures.flatMap(feature => ['--disable', feature]),
        '-c', 'web_search="disabled"', '-c', 'mcp_servers={}', '-c', 'forced_login_method="chatgpt"',
        '-c', 'model_provider="openai"', '-c', 'cli_auth_credentials_store="file"', '-c', 'model_reasoning_effort="low"', '-c', 'history.persistence="none"',
        '-c', 'project_doc_max_bytes=0', '-c', `model_instructions_file=${JSON.stringify(directory + 'classifier-instructions.md')}`,
        '--model', classifierModel, '--cd', '/empty', '--output-schema', directory + 'intent.schema.json', '--json', '--color', 'never', '-'];
}

export function decodeClassifierOutput(raw) {
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 65536) throw new Error('AI_UNAVAILABLE');
    let answer;
    let usage;
    for (const line of raw.split('\n').filter(value => value.trim())) {
        const event = guardClassifierEvent(line);
        if (['thread.started', 'turn.started'].includes(event?.type)) continue;
        if (['item.started', 'item.updated', 'item.completed'].includes(event?.type)) {
            if (!['reasoning', 'agent_message'].includes(event.item?.type)) throw new Error('AI_TOOL_ATTEMPT');
            if (event.type === 'item.completed' && event.item.type === 'agent_message') {
                if (answer !== undefined || typeof event.item.text !== 'string' || event.item.text.length > 256) throw new Error('AI_UNAVAILABLE');
                answer = event.item.text;
            }
        } else if (event?.type === 'turn.completed' && usage === undefined) usage = event.usage;
        else throw new Error('AI_UNAVAILABLE');
    }
    if (!usage || !Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0 || !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 0 || (usage.cached_input_tokens !== undefined && (!Number.isSafeInteger(usage.cached_input_tokens) || usage.cached_input_tokens < 0 || usage.cached_input_tokens > usage.input_tokens))) throw new Error('AI_USAGE_GUARD');
    if (usage.input_tokens > 8000 || usage.output_tokens > 1024) throw new Error('AI_USAGE_GUARD');
    let intent;
    try { intent = validateIntent(JSON.parse(answer)); } catch { throw new Error('AI_UNAVAILABLE'); }
    return { intent, usage: { inputTokens: usage.input_tokens, cachedInputTokens: usage.cached_input_tokens ?? 0, outputTokens: usage.output_tokens } };
}

export function createCodexClassifier({ run, signal, onUsage = () => {} } = {}) {
    return async text => {
        normalizeQuestion(text);
        if (signal?.aborted) throw new Error('AI_UNAVAILABLE');
        const options = { command: 'codex', args: classifierArguments(), input: 'Untrusted administrator question:\n' + JSON.stringify(text) };
        const raw = run ? await run(options) : await new Promise((resolve, reject) => {
            const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/node', CODEX_HOME: '/home/node/.codex', LANG: 'C.UTF-8', TMPDIR: '/tmp' };
            const child = spawn(options.command, options.args, { env, signal, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
            const chunks = [];
            let size = 0;
            let failure;
            let killer;
            let pending = '';
            const decoder = new StringDecoder('utf8');
            const terminate = code => {
                failure ??= code;
                const kill = kind => {
                    try { process.platform === 'win32' ? child.kill(kind) : process.kill(-child.pid, kind); } catch {}
                };
                kill('SIGTERM');
                killer ??= setTimeout(() => kill('SIGKILL'), 1000);
            };
            const timer = setTimeout(() => terminate('AI_UNAVAILABLE'), 45000);
            const abort = () => terminate('AI_UNAVAILABLE');
            signal?.addEventListener('abort', abort, { once: true });
            child.stdout.on('data', data => {
                size += data.length;
                if (size > 65536) terminate('AI_UNAVAILABLE');
                else {
                    chunks.push(data);
                    pending += decoder.write(data);
                    const lines = pending.split('\n');
                    pending = lines.pop();
                    try { for (const line of lines) if (line.trim()) guardClassifierEvent(line); }
                    catch (error) { terminate(error.message); }
                }
            });
            child.stderr.on('data', () => {});
            child.stdin.on('error', () => {});
            child.once('error', () => terminate('AI_UNAVAILABLE'));
            child.once('close', code => {
                clearTimeout(timer); clearTimeout(killer); signal?.removeEventListener('abort', abort);
                if (failure || code !== 0) reject(new Error(failure ?? 'AI_UNAVAILABLE'));
                else resolve(Buffer.concat(chunks).toString('utf8'));
            });
            child.stdin.end(options.input);
        });
        const result = decodeClassifierOutput(raw);
        onUsage(result.usage);
        return result.intent;
    };
}
