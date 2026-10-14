import { readFileSync } from 'node:fs';
try {
    const value = JSON.parse(readFileSync('/state/heartbeat.json', 'utf8')).observedAt;
    const age = Date.now() - value;
    if (!Number.isSafeInteger(value) || age < 0 || age > 120000) process.exitCode = 1;
} catch { process.exitCode = 1; }
