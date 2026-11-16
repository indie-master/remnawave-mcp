import { createInterface } from 'node:readline/promises';
import { createBusinessStore } from './store.mjs';

async function secret(prompt) {
    process.stdout.write(prompt);
    process.stdin.setRawMode(true); process.stdin.resume();
    return new Promise((resolve, reject) => {
        let value = '';
        const end = (error, result) => { process.stdin.removeListener('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); error ? reject(error) : resolve(result); };
        const onData = data => {
            for (const character of data.toString('utf8')) {
                if (character === '\u0003' || character === '\u0004') { end(new Error('CANCELLED')); return; }
                if (character === '\r' || character === '\n') { end(null, value); return; }
                if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
                else if (character >= ' ' && character !== '\u007f' && value.length + character.length <= 128) value += character;
                else { end(new Error('INVALID_PASSWORD_CHARACTER')); return; }
            }
        };
        process.stdin.on('data', onData);
    });
}
let store;
try {
    if (process.argv.length !== 2 || !process.stdin.isTTY || !process.stdout.isTTY) throw new Error('INTERACTIVE_TERMINAL_REQUIRED');
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    const email = await terminal.question('Почта клиента: ');
    const panelId = await terminal.question('Числовой ID пользователя панели: ');
    terminal.close();
    const password = await secret('Новый пароль, не менее 12 символов (скрыт): ');
    const confirmation = await secret('Повторите пароль (скрыт): ');
    if (password !== confirmation) throw new Error('PASSWORD_MISMATCH');
    store = createBusinessStore({ filename: '/state/business.sqlite' });
    store.provision(email, password, Number(panelId));
    process.stdout.write('Аккаунт создан. Передайте доступ клиенту безопасным способом; почта сама по себе не подтверждалась.\n');
} catch { process.stderr.write('Аккаунт не создан. Проверьте почту, ID, уникальность и пароль. Приватные данные не печатались.\n'); process.exitCode = 2; }
finally { store?.close(); }
