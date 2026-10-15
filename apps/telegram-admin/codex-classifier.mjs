import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { normalizeQuestion } from './intent-store.mjs';
import { validateIntent } from './intent.mjs';

export const codexVersion = '0.162.1';
export const classifierModel = 'gpt-6-luna';
const directory = fileURLToPath(new URL('./', import.meta.url));
export const disabledFeatures = ['shell_tool', 'plugins', 'apps', 'remote_plugin', 'multi_agent', 'multi_agent_v2', 'hooks', 'goals', 'memories', 'shell_snapshot', 'code_mode_host', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'artifact', 'in_app_browser', 'in_app_chat', 'in_app_local_automation', 'skill_search', 'skill_mcp_dependency_install', 'workspace_dependencies', 'tool_suggest', 'view_image', 'sleep_tool', 'recommended_plugins', 'request_permissions_tool', 'unbounded_connection_retries', 'daemon_auto_start', 'fast_mode', 'ultrafast_mode'];

const diagnosticReasons = ['TOOL_ATTEMPT', 'INVALID_JSONL', 'UNEXPECTED_EVENT', 'INVALID_ANSWER', 'MISSING_USAGE', 'INVALID_USAGE', 'INPUT_LIMIT', 'OUTPUT_LIMIT', 'OUTPUT_SIZE', 'PROCESS_EXIT', 'PROCESS_START', 'TIMEOUT', 'CANCELLED', 'MODEL_UNAVAILABLE', 'AUTH_UNAVAILABLE', 'TRANSPORT_UNAVAILABLE', 'CONFIG_UNAVAILABLE', 'PERMISSION_DENIED', 'CLASSIFIER_UNAVAILABLE'];

function classifierFailure(reason, values = {}) {
    const error = new Error(reason === 'TOOL_ATTEMPT' ? 'AI_TOOL_ATTEMPT' : ['MISSING_USAGE', 'INVALID_USAGE', 'INPUT_LIMIT', 'OUTPUT_LIMIT'].includes(reason) ? 'AI_USAGE_GUARD' : 'AI_UNAVAILABLE');
    error.diagnostic = classifierDiagnostic({ message: error.message, diagnostic: { reason, ...values } });
    return error;
}

export function classifierDiagnostic(error) {
    const value = error?.diagnostic;
    const result = { reason: diagnosticReasons.includes(value?.reason) ? value.reason : 'CLASSIFIER_UNAVAILABLE' };
    if (['AI_TOOL_ATTEMPT', 'AI_USAGE_GUARD', 'AI_UNAVAILABLE'].includes(error?.message)) result.cause = error.message;
    for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'exitCode']) {
        if (Number.isSafeInteger(value?.[key]) && value[key] >= 0 && (key !== 'exitCode' || value[key] <= 255)) result[key] = value[key];
    }
    if (['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV'].includes(value?.signal)) result.signal = value.signal;
    return result;
}

function failureHint(text) {
    if (/model[^\n]{0,160}(?:not supported|not available|does not exist)|unsupported model/i.test(text)) return 'MODEL_UNAVAILABLE';
    if (/unauthorized|authentication failed|not logged in|token[^\n]{0,60}expired|401 Unauthorized/i.test(text)) return 'AUTH_UNAVAILABLE';
    if (/certificate|tls handshake|error sending request|connection refused|failed to connect|dns error/i.test(text)) return 'TRANSPORT_UNAVAILABLE';
    if (/permission denied|operation not permitted|read-only file system/i.test(text)) return 'PERMISSION_DENIED';
    if (/invalid config|error loading config|unknown variant|unexpected argument|invalid value|unknown feature/i.test(text)) return 'CONFIG_UNAVAILABLE';
    return 'CLASSIFIER_UNAVAILABLE';
}

export function guardClassifierEvent(line) {
    let event;
    try { event = JSON.parse(line); } catch { throw classifierFailure('INVALID_JSONL'); }
    if (String(event?.type).startsWith('item.') && !['reasoning', 'agent_message'].includes(event.item?.type)) throw classifierFailure('TOOL_ATTEMPT');
    if (['error', 'turn.failed'].includes(event?.type)) throw classifierFailure(failureHint(String(event.message ?? event.error?.message ?? '')));
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
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 65536) throw classifierFailure('OUTPUT_SIZE');
    let answer;
    let usage;
    for (const line of raw.split('\n').filter(value => value.trim())) {
        const event = guardClassifierEvent(line);
        if (['thread.started', 'turn.started'].includes(event?.type)) continue;
        if (['item.started', 'item.updated', 'item.completed'].includes(event?.type)) {
            if (!['reasoning', 'agent_message'].includes(event.item?.type)) throw classifierFailure('TOOL_ATTEMPT');
            if (event.type === 'item.completed' && event.item.type === 'agent_message') {
                if (answer !== undefined || typeof event.item.text !== 'string' || event.item.text.length > 256) throw classifierFailure('INVALID_ANSWER');
                answer = event.item.text;
            }
        } else if (event?.type === 'turn.completed' && usage === undefined) usage = event.usage;
        else throw classifierFailure('UNEXPECTED_EVENT');
    }
    if (!usage) throw classifierFailure('MISSING_USAGE');
    const numbers = { inputTokens: usage.input_tokens, cachedInputTokens: usage.cached_input_tokens, outputTokens: usage.output_tokens };
    if (!Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0 || !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 0 || (usage.cached_input_tokens !== undefined && (!Number.isSafeInteger(usage.cached_input_tokens) || usage.cached_input_tokens < 0 || usage.cached_input_tokens > usage.input_tokens))) throw classifierFailure('INVALID_USAGE', numbers);
    if (usage.input_tokens > 8000) throw classifierFailure('INPUT_LIMIT', numbers);
    if (usage.output_tokens > 1024) throw classifierFailure('OUTPUT_LIMIT', numbers);
    let intent;
    try { intent = validateIntent(JSON.parse(answer)); } catch { throw classifierFailure('INVALID_ANSWER'); }
    return { intent, usage: { inputTokens: usage.input_tokens, cachedInputTokens: usage.cached_input_tokens ?? 0, outputTokens: usage.output_tokens } };
}

export function createCodexClassifier({ run, signal, onUsage = () => {}, spawnProcess = spawn } = {}) {
    return async text => {
        normalizeQuestion(text);
        if (signal?.aborted) throw classifierFailure('CANCELLED');
        const options = { command: 'codex', args: classifierArguments(), input: 'Untrusted administrator question:\n' + JSON.stringify(text) };
        const raw = run ? await run(options) : await new Promise((resolve, reject) => {
            const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/node', CODEX_HOME: '/home/node/.codex', LANG: 'C.UTF-8', TMPDIR: '/tmp', CODEX_CA_CERTIFICATE: '/etc/ssl/certs/ca-certificates.crt' };
            const child = spawnProcess(options.command, options.args, { env, signal, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
            const chunks = [];
            let size = 0;
            let failure;
            let killer;
            let pending = '';
            let stderr = '';
            const decoder = new StringDecoder('utf8');
            const terminate = error => {
                failure ??= error;
                const kill = kind => {
                    try { process.platform === 'win32' ? child.kill(kind) : process.kill(-child.pid, kind); } catch {}
                };
                kill('SIGTERM');
                killer ??= setTimeout(() => kill('SIGKILL'), 1000);
            };
            const timer = setTimeout(() => terminate(classifierFailure('TIMEOUT')), 45000);
            const abort = () => terminate(classifierFailure('CANCELLED'));
            signal?.addEventListener('abort', abort, { once: true });
            child.stdout.on('data', data => {
                size += data.length;
                if (size > 65536) terminate(classifierFailure('OUTPUT_SIZE'));
                else {
                    chunks.push(data);
                    pending += decoder.write(data);
                    const lines = pending.split('\n');
                    pending = lines.pop();
                    try { for (const line of lines) if (line.trim()) guardClassifierEvent(line); }
                    catch (error) { terminate(error); }
                }
            });
            child.stderr.on('data', data => { if (stderr.length < 8192) stderr += data.toString('utf8').slice(0, 8192 - stderr.length); });
            child.stdin.on('error', () => {});
            child.once('error', () => terminate(classifierFailure(signal?.aborted ? 'CANCELLED' : 'PROCESS_START')));
            child.once('close', (code, exitSignal) => {
                clearTimeout(timer); clearTimeout(killer); signal?.removeEventListener('abort', abort);
                if (failure || code !== 0) {
                    const hint = failureHint(stderr);
                    const error = failure ?? classifierFailure(hint === 'CLASSIFIER_UNAVAILABLE' ? 'PROCESS_EXIT' : hint);
                    error.diagnostic = classifierDiagnostic({ message: error.message, diagnostic: { ...classifierDiagnostic(error), exitCode: code, signal: exitSignal } });
                    reject(error);
                }
                else resolve(Buffer.concat(chunks).toString('utf8'));
            });
            child.stdin.end(options.input);
        });
        const result = decodeClassifierOutput(raw);
        onUsage(result.usage);
        return result.intent;
    };
}
