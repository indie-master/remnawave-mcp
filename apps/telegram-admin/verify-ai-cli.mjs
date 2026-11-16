import { spawnSync } from 'node:child_process';
import { codexVersion, classifierArguments, disabledFeatures } from './codex-classifier.mjs';

export function verifyClassifierCli({ requireLogin = true, run = args => spawnSync('codex', args, { encoding: 'utf8', timeout: 10000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/node', CODEX_HOME: '/home/node/.codex', CODEX_CA_CERTIFICATE: '/etc/ssl/certs/ca-certificates.crt' } }) } = {}) {
    const version = run(['--version']);
    if (version.status !== 0 || version.stdout?.trim() !== `codex-cli ${codexVersion}`) throw new Error('AI_CLI_VERSION_MISMATCH');
    const flags = disabledFeatures.flatMap(feature => ['--disable', feature]);
    const features = run([...flags, 'features', 'list']);
    if (features.status !== 0 || !disabledFeatures.every(feature => new RegExp(`^${feature}\\s+.+\\s+false$`, 'm').test(features.stdout))) throw new Error('AI_CLI_FEATURES_UNAVAILABLE');
    const args = classifierArguments();
    const help = run([...args.slice(0, -1), '--help']);
    if (help.status !== 0 || !['--json', '--ephemeral', '--output-schema', '--ignore-user-config'].every(flag => help.stdout?.includes(flag))) throw new Error('AI_CLI_FEATURES_UNAVAILABLE');
    if (requireLogin) {
        const auth = run(['-c', 'cli_auth_credentials_store="file"', 'login', 'status']);
        if (auth.status !== 0 || !/ChatGPT/i.test(String(auth.stdout) + String(auth.stderr))) throw new Error('AI_CHATGPT_LOGIN_REQUIRED');
    }
}
