#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [[ "${EUID}" -ne 0 ]]; then
    printf 'Run this setup as root on the chosen VPS. Nothing was changed.\n' >&2
    exit 2
fi
if [[ ! -r /dev/tty || ! -w /dev/tty || -e .env || -L .env || -L secrets || -e secrets/telegram-bot-token.txt || -L secrets/telegram-bot-token.txt || -e secrets/panel-api-token.txt || -L secrets/panel-api-token.txt ]]; then
    printf 'Interactive terminal required; existing configuration will not be overwritten. Nothing was changed.\n' >&2
    exit 2
fi
read -r -p 'Panel HTTPS origin, without /api: ' panel_url < /dev/tty
read -r -p 'Bot username, without @: ' bot_username < /dev/tty
read -r -p 'Sole administrator numeric Telegram ID: ' admin_id < /dev/tty
if [[ ! "$panel_url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$ || ! "$bot_username" =~ ^[A-Za-z0-9_]{5,32}$ || ! "$admin_id" =~ ^[1-9][0-9]{0,15}$ ]]; then
    printf 'Invalid address, username or administrator ID. Nothing was changed.\n' >&2
    exit 2
fi
if (( admin_id > 9007199254740991 )); then
    printf 'Administrator ID is out of range. Nothing was changed.\n' >&2
    exit 2
fi
read -r -s -p 'Existing Telegram bot token (hidden): ' telegram_token < /dev/tty
printf '\n' > /dev/tty
read -r -s -p 'Separate read-only panel token (hidden): ' panel_token < /dev/tty
printf '\n' > /dev/tty
if [[ ! "$telegram_token" =~ ^[1-9][0-9]{4,19}:[A-Za-z0-9_-]{30,128}$ || -z "$panel_token" || ${#panel_token} -gt 4096 || "$panel_token" == *[[:space:]]* ]]; then
    unset telegram_token panel_token
    printf 'Invalid token format. Nothing was changed.\n' >&2
    exit 2
fi
set -C
mkdir -p -- secrets
chmod 0700 secrets
printf '%s\n' "$telegram_token" > secrets/telegram-bot-token.txt
printf '%s\n' "$panel_token" > secrets/panel-api-token.txt
unset telegram_token panel_token
chown 1000:1000 secrets secrets/telegram-bot-token.txt secrets/panel-api-token.txt
chmod 0400 secrets/telegram-bot-token.txt secrets/panel-api-token.txt
printf 'REMNAWAVE_BASE_URL=%s\nBOT_USERNAME=%s\nTELEGRAM_ADMIN_ID=%s\nPANEL_USERS_READ_ENABLED=true\n' "$panel_url" "$bot_username" "$admin_id" > .env
chmod 0600 .env
printf 'Private files created. No container was started and no bot settings were changed.\n'
