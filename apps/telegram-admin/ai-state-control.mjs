import { unlinkSync } from 'node:fs';
import { createRunSafety } from './run-safety.mjs';

if (process.argv.slice(2).join(' ') !== '--acknowledge-ai-pause') {
    process.stderr.write('Resolve the AI guard cause first, then explicitly acknowledge its pause.\n');
    process.exitCode = 2;
} else {
    try {
        try { unlinkSync('/state/classifier-paused'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        createRunSafety({ directory: '/state' }).acknowledge();
        process.stdout.write('AI pause acknowledged. Quota and credentials were not changed.\n');
    } catch { process.stderr.write('AI pause could not be acknowledged.\n'); process.exitCode = 2; }
}
