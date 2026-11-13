import { spawnSync } from 'node:child_process';

const option = process.argv.slice(2).join(' ');
if (!['--device-auth', '--status', '--logout'].includes(option)) {
    process.stderr.write('Choose explicitly: --device-auth, --status or --logout.\n');
    process.exitCode = 2;
} else {
    process.umask(0o077);
    const args = option === '--logout' ? ['logout'] : ['-c', 'cli_auth_credentials_store="file"', 'login', option === '--status' ? 'status' : '--device-auth'];
    const result = spawnSync('codex', args, { stdio: 'inherit', env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/home/node', CODEX_HOME: '/home/node/.codex', LANG: 'C.UTF-8', CODEX_CA_CERTIFICATE: '/etc/ssl/certs/ca-certificates.crt' } });
    process.exitCode = result.status ?? 2;
}
