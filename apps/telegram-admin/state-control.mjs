import { createRunSafety } from './run-safety.mjs';

if (process.argv.slice(2).join(' ') !== '--acknowledge-pause') {
    process.stderr.write('Refused: explicit acknowledgement of the receiver conflict or startup failure is required.\n');
    process.exitCode = 2;
} else {
    try {
        createRunSafety({ directory: process.env.BOT_STATE_DIRECTORY ?? '/state' }).acknowledge();
        process.stdout.write('Pause acknowledged. Restart only this bot after resolving the conflict or configuration problem.\n');
    } catch {
        process.stderr.write('Pause unchanged: state storage unavailable.\n');
        process.exitCode = 1;
    }
}
