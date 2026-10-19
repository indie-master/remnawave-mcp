import { readFileSync } from 'node:fs';
try {
    const heartbeat = JSON.parse(readFileSync('/state/heartbeat.json', 'utf8'));
    const value = heartbeat.observedAt;
    const age = Date.now() - value;
    if (!Number.isSafeInteger(value) || age < 0 || age > 120000 || (heartbeat.phase !== undefined && heartbeat.phase !== 'ready')) process.exitCode = 1;
} catch { process.exitCode = 1; }
