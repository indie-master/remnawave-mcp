set +x
set -euo pipefail
umask 077

fail() { printf '%s\n' "$1" >&2; exit 2; }
docker_local() { env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH docker --host unix:///var/run/docker.sock "$@"; }
help_text() {
    printf '%s\n' 'botctl: только этот проект, только локальный Docker.' \
        '  help | status | logs [bot|ai]' \
        '  adopt                   сохранить текущий режим без перезапуска' \
        '  init [--ai] [--enhanced] создать настройки нового развёртывания' \
        '  build | check           собрать образы / проверить настройки офлайн' \
        '  start | apply | stop    запустить / применить настройки / остановить' \
        '  config | settings       nano: адрес/администратор или режим/лимиты/отчёты' \
        '  token panel|telegram    скрытый ввод замены, без чтения старого токена' \
        '  update FULL_SHA         подготовить проверенную ревизию; затем apply' \
        '  rollback                подготовить предыдущую совместимую ревизию; затем apply' \
        'Тома, квоты, offset, авторизация и защитные паузы не удаляются.'
}

owned_project() {
    BOT_ID=''; AI_ID=''
    local identifiers identifier details service
    identifiers=$(docker_local ps -aq --filter label=com.docker.compose.project=panel-admin-bot) || fail 'Docker недоступен.'
    for identifier in $identifiers; do
        [[ "$identifier" =~ ^[a-f0-9]{12,64}$ ]] || fail 'Некорректный ID контейнера.'
        details=$(docker_local inspect --format '{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$identifier") || fail 'Не удалось проверить принадлежность контейнера.'
        service=${details%%|*}
        [[ "${details#*|}" == "$APP" ]] || fail 'Compose-проект принадлежит другой папке. Ничего не изменено.'
        case "$service" in
            bot) [[ -z "$BOT_ID" ]] || fail 'Несколько получателей bot; нужна ручная проверка.'; BOT_ID=$identifier ;;
            ai) [[ -z "$AI_ID" ]] || fail 'Несколько ai-контейнеров; нужна ручная проверка.'; AI_ID=$identifier ;;
            *) fail 'Неизвестный сервис в проекте. Ничего не изменено.' ;;
        esac
    done
}

private_file() {
    [[ -f "$1" && ! -L "$1" && $(stat -c %u "$1") == 0 && $(stat -c %h "$1") == 1 && $(stat -c %s "$1") -le 4096 ]] || fail 'Нужен небольшой обычный приватный файл root, без ссылок.'
    case $(stat -c %a "$1") in 400|600) ;; *) fail 'Приватный файл должен иметь права 600 или 400.' ;; esac
}

load_settings() {
    local settings_file=${1:-"$OPS/settings.env"}
    private_file "$settings_file"
    AI_MODE=''; UI_MODE=''; LIMIT=''; REPORTS=''
    local line key value count=0 action
    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line#"${line%%[![:space:]]*}"}"
        line="${line%"${line##*[![:space:]]}"}"
        [[ -z "$line" || "$line" == \#* ]] && continue
        [[ "$line" == *=* && "$line" != *[[:space:]]* ]] || fail 'Некорректная строка settings.env.'
        key=${line%%=*}; value=${line#*=}
        case "$key" in
            AI_ENABLED) [[ -z "$AI_MODE" && "$value" =~ ^(true|false)$ ]] || fail 'Некорректный AI_ENABLED.'; AI_MODE=$value ;;
            BOT_ENHANCED_UI) [[ -z "$UI_MODE" && "$value" =~ ^(true|false)$ ]] || fail 'Некорректный BOT_ENHANCED_UI.'; UI_MODE=$value ;;
            AI_DAILY_LIMIT) [[ -z "$LIMIT" && "$value" =~ ^(0|[1-9][0-9]{0,2})$ && "$value" -le 100 ]] || fail 'Лимит должен быть целым 0..100.'; LIMIT=$value ;;
            PANEL_ALLOWED_REPORTS) [[ -z "$REPORTS" && -n "$value" ]] || fail 'Некорректный список отчётов.'; REPORTS=$value ;;
            *) fail 'Неизвестный ключ settings.env.' ;;
        esac
        count=$((count + 1))
    done < "$settings_file"
    [[ "$count" == 4 ]] || fail 'settings.env должен содержать четыре известных ключа.'
    if [[ "$REPORTS" != all && "$REPORTS" != none ]]; then
        [[ "$REPORTS" != ,* && "$REPORTS" != *, && "$REPORTS" != *,,* ]] || fail 'Некорректный список отчётов.'
        local seen=','
        local -a actions
        IFS=',' read -ra actions <<< "$REPORTS"
        for action in "${actions[@]}"; do
            case "$action" in version|stats|nodes|expiring|users|online|node_details|hosts|profiles|internal_squads|external_squads|system|bandwidth|health) ;; *) fail 'Неизвестный отчёт.' ;; esac
            [[ "$seen" != *",$action,"* ]] || fail 'Отчёт указан повторно.'
            seen+="$action,"
        done
    fi
    COMPOSE=(-p panel-admin-bot --project-directory "$APP" --env-file "$APP/.env" -f "$APP/compose.yaml" -f "$APP/compose.continuous.yaml")
    [[ "$AI_MODE" != true ]] || COMPOSE+=(-f "$APP/compose.ai.yaml")
    [[ "$UI_MODE" != true ]] || COMPOSE+=(-f "$APP/compose.features.yaml")
    COMPOSE+=(-f "$APP/compose.controls.yaml")
    [[ "$AI_MODE" != true ]] || COMPOSE+=(-f "$APP/compose.controls.ai.yaml")
    SERVICES=(bot)
    [[ "$AI_MODE" != true ]] || SERVICES=(ai bot)
}

compose() {
    env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH -u COMPOSE_FILE -u COMPOSE_PROFILES -u COMPOSE_PROJECT_NAME -u COMPOSE_ENV_FILES -u REMNAWAVE_BASE_URL -u BOT_USERNAME -u TELEGRAM_ADMIN_ID -u PANEL_USERS_READ_ENABLED \
        AI_DAILY_LIMIT="$LIMIT" PANEL_ALLOWED_REPORTS="$REPORTS" docker --host unix:///var/run/docker.sock compose "${COMPOSE[@]}" "$@"
}

cleanup() {
    [[ -z "${DRAFT:-}" ]] || rm -f -- "$DRAFT"
    [[ -z "${SECRET_DRAFT:-}" ]] || rm -f -- "$SECRET_DRAFT"
    unset NEW_TOKEN CONFIRM_TOKEN
}

offline_validate() {
    local kind=$1 file=$2
    docker_local run --rm --pull never --network none --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges:true --memory 128m --memory-swap 128m --cpus 0.25 --pids-limit 32 \
        --mount "type=bind,src=$file,dst=/configuration.env,readonly" --entrypoint node panel-admin-bot:local /app/apps/telegram-admin/ops-config.mjs "$kind" /configuration.env
}

check_file() {
    local kind=$1 file=$2
    private_file "$file"
    DRAFT=$(mktemp "$OPS/check.XXXXXXXX")
    cp -- "$file" "$DRAFT" || return
    chown 1000:1000 "$DRAFT" || return
    chmod 0400 "$DRAFT" || return
    offline_validate "$kind" "$DRAFT" || return
    rm -f -- "$DRAFT"; DRAFT=''
}

check_configuration() {
    check_file base "$APP/.env" || return
    check_file controls "$OPS/settings.env" || return
    compose config --quiet
}

save_settings() {
    DRAFT=$(mktemp "$OPS/settings.XXXXXXXX")
    printf 'AI_ENABLED=%s\nBOT_ENHANCED_UI=%s\nAI_DAILY_LIMIT=%s\nPANEL_ALLOWED_REPORTS=%s\n' "$AI_MODE" "$UI_MODE" "$LIMIT" "$REPORTS" > "$DRAFT"
    chmod 0600 "$DRAFT"; mv -- "$DRAFT" "$OPS/settings.env"; DRAFT=''
    load_settings
}

edit_configuration() {
    local kind=$1 target=$2
    [[ -r /dev/tty && -w /dev/tty ]] || fail 'Для nano нужен интерактивный SSH-терминал.'
    command -v nano >/dev/null || fail 'nano не установлен. Автоматическая установка пакетов не выполняется.'
    private_file "$target"
    DRAFT=$(mktemp "$OPS/edit.XXXXXXXX")
    cp -- "$target" "$DRAFT"; chmod 0600 "$DRAFT"
    nano -- "$DRAFT" < /dev/tty > /dev/tty 2> /dev/tty
    [[ -f "$DRAFT" && ! -L "$DRAFT" && $(stat -c %h "$DRAFT") == 1 && $(stat -c %s "$DRAFT") -le 4096 ]] || fail 'Редактор создал недопустимый файл.'
    chown 1000:1000 "$DRAFT"; chmod 0400 "$DRAFT"
    offline_validate "$kind" "$DRAFT"
    chown 0:0 "$DRAFT"; chmod 0600 "$DRAFT"
    mv -- "$DRAFT" "$target"; DRAFT=''
    printf 'Настройки сохранены. Работающие контейнеры не менялись. Применение: botctl apply\n'
}

replace_token() {
    local kind=$1 target
    [[ -r /dev/tty && -w /dev/tty && -d "$APP/secrets" && ! -L "$APP/secrets" ]] || fail 'Нужны SSH-терминал и существующая папка secrets.'
    case "$kind" in panel) target="$APP/secrets/panel-api-token.txt" ;; telegram) target="$APP/secrets/telegram-bot-token.txt" ;; *) fail 'Укажите token panel или token telegram.' ;; esac
    [[ -f "$target" && ! -L "$target" && $(stat -c %h "$target") == 1 ]] || fail 'Нужен существующий обычный файл токена, без ссылок.'
    read -r -s -p 'Новый токен (ввод скрыт): ' NEW_TOKEN < /dev/tty; printf '\n' > /dev/tty
    read -r -s -p 'Повторите новый токен: ' CONFIRM_TOKEN < /dev/tty; printf '\n' > /dev/tty
    [[ -n "$NEW_TOKEN" && "$NEW_TOKEN" == "$CONFIRM_TOKEN" && ${#NEW_TOKEN} -le 4096 && "$NEW_TOKEN" != *[[:space:]]* ]] || fail 'Токены не совпали или формат неверен. Старый файл не менялся.'
    [[ "$kind" != telegram || "$NEW_TOKEN" =~ ^[1-9][0-9]{4,19}:[A-Za-z0-9_-]{30,128}$ ]] || fail 'Неверный формат Telegram-токена. Старый файл не менялся.'
    SECRET_DRAFT=$(mktemp "$APP/secrets/.new-token.XXXXXXXX")
    printf '%s\n' "$NEW_TOKEN" > "$SECRET_DRAFT"; unset NEW_TOKEN CONFIRM_TOKEN
    chown 1000:1000 "$SECRET_DRAFT"; chmod 0400 "$SECRET_DRAFT"
    mv -- "$SECRET_DRAFT" "$target"; SECRET_DRAFT=''
    printf 'Новый токен сохранён. Старый не читался и не копировался. Применение bind-mount: botctl apply\n'
}

read_record() {
    local file=$1 line key value count=0
    private_file "$file"
    REVISION=''; BOT_IMAGE=''; AI_IMAGE=''
    while IFS= read -r line || [[ -n "$line" ]]; do
        key=${line%%=*}; value=${line#*=}
        case "$key" in
            REVISION) [[ -z "$REVISION" && "$value" =~ ^[a-f0-9]{40}$ ]] || fail 'Повреждена запись ревизии.'; REVISION=$value ;;
            BOT_IMAGE) [[ -z "$BOT_IMAGE" && "$value" =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'Повреждена запись образа.'; BOT_IMAGE=$value ;;
            AI_IMAGE) [[ -z "$AI_IMAGE" && ( "$value" == none || "$value" =~ ^sha256:[a-f0-9]{64}$ ) ]] || fail 'Повреждена запись образа ИИ.'; AI_IMAGE=$value ;;
            *) fail 'Неизвестное поле записи ревизии.' ;;
        esac
        count=$((count + 1))
    done < "$file"
    [[ "$count" == 3 ]] || fail 'Неполная запись ревизии.'
}

clean_checkout() {
    [[ $(git -C "$REPO" rev-parse --show-toplevel) == "$REPO" ]] || fail 'Неожиданный корень Git.'
    git -C "$REPO" diff --quiet && git -C "$REPO" diff --cached --quiet && [[ -z $(git -C "$REPO" ls-files --others --exclude-standard) ]] || fail 'Есть локальные изменения исходников. Они не сбрасывались.'
}

retag_record() {
    docker_local image inspect "$BOT_IMAGE" >/dev/null
    [[ "$AI_IMAGE" == none ]] || docker_local image inspect "$AI_IMAGE" >/dev/null
    docker_local tag "$BOT_IMAGE" panel-admin-bot:local
    [[ "$AI_IMAGE" == none ]] || docker_local tag "$AI_IMAGE" panel-admin-ai:local
}

prepare_update() {
    local target=$1
    [[ "$target" =~ ^[a-f0-9]{40}$ ]] || fail 'Нужен полный SHA проверенного коммита.'
    [[ ! -e "$OPS/pending" && ! -L "$OPS/pending" ]] || fail 'Предыдущее обновление ещё не применено; используйте apply или rollback.'
    clean_checkout
    read_record "$OPS/active.env"
    [[ $(git -C "$REPO" rev-parse HEAD) == "$REVISION" ]] || fail 'Текущие исходники не совпадают с принятой ревизией.'
    [[ -n "$BOT_ID" && $(docker_local inspect --format '{{.Image}}' "$BOT_ID") == "$BOT_IMAGE" ]] || fail 'Образ bot не совпадает с принятой ревизией.'
    [[ "$AI_IMAGE" == none || ( -n "$AI_ID" && $(docker_local inspect --format '{{.Image}}' "$AI_ID") == "$AI_IMAGE" ) ]] || fail 'Образ ai не совпадает с принятой ревизией.'
    git -C "$REPO" fetch --no-tags origin >/dev/null 2>&1 || fail 'Не удалось получить исходники из origin.'
    git -C "$REPO" cat-file -e "$target^{commit}" || fail 'Коммит отсутствует в локальной истории.'
    git -C "$REPO" cat-file -e "$target:apps/telegram-admin/botctl" || fail 'Ревизия не поддерживает этот помощник.'
    [[ ! -e "$OPS/previous.env" && ! -L "$OPS/previous.env" ]] || private_file "$OPS/previous.env"
    cp -- "$OPS/active.env" "$OPS/previous.env"; chmod 0600 "$OPS/previous.env"
    printf '%s\n' "$target" > "$OPS/pending"
    git -C "$REPO" checkout --detach "$target" >/dev/null 2>&1
    if compose build "${SERVICES[@]}" && check_configuration; then
        printf 'Ревизия подготовлена. Работающие контейнеры не менялись. Следующий шаг: botctl apply\n'
    else
        retag_record
        git -C "$REPO" checkout --detach "$REVISION" >/dev/null 2>&1
        rm -f -- "$OPS/pending"
        fail 'Подготовка не удалась: исходники и теги возвращены. Работающие контейнеры не менялись.'
    fi
}

prepare_rollback() {
    clean_checkout
    read_record "$OPS/previous.env"
    [[ "$AI_MODE" != true || "$AI_IMAGE" != none ]] || fail 'Предыдущая ревизия без ai. Сначала явно измените режим в settings.'
    git -C "$REPO" cat-file -e "$REVISION:apps/telegram-admin/botctl" || fail 'Для этой старой ревизии нужен ручной откат по инструкции.'
    docker_local image inspect "$BOT_IMAGE" >/dev/null
    [[ "$AI_IMAGE" == none ]] || docker_local image inspect "$AI_IMAGE" >/dev/null
    git -C "$REPO" checkout --detach "$REVISION" >/dev/null 2>&1
    retag_record
    printf '%s\n' "$REVISION" > "$OPS/pending"
    printf 'Предыдущие исходники и образы подготовлены. Текущее состояние/настройки не откатывались. Следующий шаг: botctl apply\n'
}

apply_configuration() {
    clean_checkout
    check_configuration
    [[ "$AI_MODE" == true || -z "$AI_ID" ]] || docker_local stop --time 15 "$AI_ID" >/dev/null
    compose up -d --no-build --no-deps --force-recreate "${SERVICES[@]}"
    owned_project
    local attempt status healthy
    healthy=false
    for attempt in {1..30}; do
        status=$(docker_local inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$BOT_ID")
        if [[ "$status" == 'running|healthy' && ( "$AI_MODE" != true || $(docker_local inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$AI_ID") == 'running|healthy' ) ]]; then healthy=true; break; fi
        sleep 3
    done
    [[ "$healthy" == true ]] || fail 'Не все контейнеры healthy. Используйте status/logs; пауза не снималась, автоматического отката нет.'
    local revision bot_image ai_image=none
    revision=$(git -C "$REPO" rev-parse HEAD)
    bot_image=$(docker_local inspect --format '{{.Image}}' "$BOT_ID")
    [[ "$AI_MODE" != true ]] || ai_image=$(docker_local inspect --format '{{.Image}}' "$AI_ID")
    [[ "$revision" =~ ^[a-f0-9]{40}$ && "$bot_image" =~ ^sha256:[a-f0-9]{64}$ && ( "$ai_image" == none || "$ai_image" =~ ^sha256:[a-f0-9]{64}$ ) ]] || fail 'Не удалось зафиксировать принятую ревизию.'
    DRAFT=$(mktemp "$OPS/active.XXXXXXXX")
    printf 'REVISION=%s\nBOT_IMAGE=%s\nAI_IMAGE=%s\n' "$revision" "$bot_image" "$ai_image" > "$DRAFT"
    mv -- "$DRAFT" "$OPS/active.env"; DRAFT=''
    rm -f -- "$OPS/pending"
    printf 'Наш проект healthy. Состояние, квоты, авторизация и паузы не сбрасывались.\n'
}

main() {
    APP=$1; shift
    local command=${1:-help}; shift || true
    [[ "$command" != help || $# != 0 ]] || { help_text; return; }
    case "$command" in status|adopt|build|check|start|apply|stop|config|settings|rollback) [[ $# == 0 ]] || fail 'Лишние аргументы.' ;; logs) [[ $# -le 1 && "${1:-bot}" =~ ^(bot|ai)$ ]] || fail 'Используйте logs bot или logs ai.' ;; token) [[ $# == 1 && "$1" =~ ^(panel|telegram)$ ]] || fail 'Используйте token panel или token telegram.' ;; update) [[ $# == 1 ]] || fail 'Используйте update FULL_SHA.' ;; init) ;; *) fail 'Неизвестная команда. Используйте help.' ;; esac
    [[ "$EUID" == 0 && "$APP" != *[,\|$'\n']* ]] || fail 'Нужен root SSH-терминал и обычный путь проекта.'
    [[ $(stat -c %u "$APP") == 0 && ! -L "$APP/ops-host.sh" && $(stat -c %u "$APP/ops-host.sh") == 0 ]] || fail 'Помощник должен находиться в checkout, принадлежащем root.'
    OPS="$APP/.ops"; REPO=$(cd -- "$APP/../.." && pwd -P)
    owned_project
    if [[ "$command" == status ]]; then docker_local ps -a --filter label=com.docker.compose.project=panel-admin-bot --format 'table {{.Names}}\t{{.Status}}'; return; fi
    if [[ "$command" == logs ]]; then local identifier=$BOT_ID; [[ "${1:-bot}" != ai ]] || identifier=$AI_ID; [[ -n "$identifier" ]] || fail 'Этот контейнер ещё не создан.'; docker_local logs --tail 40 "$identifier"; return; fi
    [[ ! -L "$OPS" && ( ! -e "$OPS" || -d "$OPS" ) ]] || fail 'Недопустимая папка .ops.'
    mkdir -p -- "$OPS"
    [[ $(stat -c %u "$OPS") == 0 ]] || fail '.ops должна принадлежать root.'
    chmod 0700 "$OPS"
    [[ ! -L "$OPS/lock" && ( ! -e "$OPS/lock" || $(stat -c %h "$OPS/lock") == 1 ) ]] || fail 'Недопустимый файл блокировки.'
    exec 9>>"$OPS/lock"; chmod 0600 "$OPS/lock"
    flock -n 9 || fail 'Другой botctl уже выполняется.'
    DRAFT=''; SECRET_DRAFT=''; trap cleanup EXIT
    if [[ "$command" == stop ]]; then [[ -z "$BOT_ID" ]] || docker_local stop --time 45 "$BOT_ID" >/dev/null; [[ -z "$AI_ID" ]] || docker_local stop --time 15 "$AI_ID" >/dev/null; printf 'Остановлены только наши получатели. Тома сохранены.\n'; return; fi
    if [[ "$command" == adopt || "$command" == init ]]; then
        [[ ! -e "$OPS/settings.env" && ! -L "$OPS/settings.env" ]] || fail 'Настройки уже существуют; используйте settings.'
        if [[ "$command" == adopt ]]; then
            [[ -n "$BOT_ID" ]] || fail 'Для adopt нужен существующий работающий bot.'
            DRAFT=$(mktemp "$OPS/settings.XXXXXXXX")
            docker_local exec "$BOT_ID" node --input-type=module -e 'for (const [key, fallback] of Object.entries({AI_ENABLED:"false",BOT_ENHANCED_UI:"false",AI_DAILY_LIMIT:"100",PANEL_ALLOWED_REPORTS:"all"})) console.log(key+"="+(process.env[key]??fallback));' > "$DRAFT"
            load_settings "$DRAFT"
            mv -- "$DRAFT" "$OPS/settings.env"; DRAFT=''
        else
            [[ -z "$BOT_ID" && -z "$AI_ID" ]] || fail 'Для существующего проекта используйте adopt.'
            AI_MODE=false; UI_MODE=false; LIMIT=100; REPORTS=all
            local option
            for option in "$@"; do case "$option" in --ai) [[ "$AI_MODE" == false ]] || fail 'Флаг повторён.'; AI_MODE=true ;; --enhanced) [[ "$UI_MODE" == false ]] || fail 'Флаг повторён.'; UI_MODE=true ;; *) fail 'Используйте init [--ai] [--enhanced].' ;; esac; done
            save_settings
        fi
        printf 'Режим сохранён локально. Контейнеры и токены не менялись.\n'; return
    fi
    case "$command" in
        config) edit_configuration base "$APP/.env"; return ;;
        settings) edit_configuration controls "$OPS/settings.env"; return ;;
        token) replace_token "$1"; return ;;
    esac
    load_settings
    case "$command" in
        build) compose config --quiet; compose build "${SERVICES[@]}" ;;
        check) check_configuration ;;
        start|apply) apply_configuration ;;
        update) prepare_update "$1" ;;
        rollback) prepare_rollback ;;
    esac
}

main "$@"
