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
        '  token panel|telegram|write скрытый ввод, без чтения старого токена' \
        '  update FULL_SHA         подготовить проверенную ревизию; затем apply' \
        '  rollback                подготовить предыдущую совместимую ревизию; затем apply' \
        '  extensions              nano: дополнительные выключенные модули' \
        '  backup                  остановить проект и сохранить состояние без токенов/auth' \
        '  restore BACKUP_ID       восстановить доверенный снимок только в пустое состояние' \
        '  business settings|build|start|stop|status|account отдельный кабинет' \
        '  voice build|start|stop|status отдельное локальное распознавание' \
        '  media build|start|stop|status отдельный локальный OCR' \
        '  apply-all               применить ядро и выбранные env-модули' \
        '  stop-all                остановить только все модули этого проекта' \
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
    if [[ -f "$APP/.env.extensions" ]]; then
        private_file "$APP/.env.extensions"
        if [[ $(sed -n '/^ADMIN_WRITE_ENABLED=true$/p' "$APP/.env.extensions") == ADMIN_WRITE_ENABLED=true ]]; then COMPOSE+=(-f "$APP/compose.write.yaml"); fi
    fi
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
    [[ ! -e "$APP/.env.extensions" ]] || check_file extensions "$APP/.env.extensions" || return
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
    case "$kind" in panel) target="$APP/secrets/panel-api-token.txt" ;; telegram) target="$APP/secrets/telegram-bot-token.txt" ;; write) target="$APP/secrets/panel-write-token.txt" ;; search) target="$REPO/apps/business/secrets/search-api-token.txt"; [[ ! -L "$REPO/apps/business/secrets" ]] || fail 'Недопустимая папка secrets.'; mkdir -p -- "$REPO/apps/business/secrets"; chmod 0700 "$REPO/apps/business/secrets" ;; *) fail 'Укажите token panel, telegram, write или search.' ;; esac
    [[ ( "$kind" =~ ^(write|search)$ && ! -e "$target" && ! -L "$target" ) || ( -f "$target" && ! -L "$target" && $(stat -c %h "$target") == 1 ) ]] || fail 'Нужен обычный файл токена, без ссылок.'
    read -r -s -p 'Новый токен (ввод скрыт): ' NEW_TOKEN < /dev/tty; printf '\n' > /dev/tty
    read -r -s -p 'Повторите новый токен: ' CONFIRM_TOKEN < /dev/tty; printf '\n' > /dev/tty
    [[ -n "$NEW_TOKEN" && "$NEW_TOKEN" == "$CONFIRM_TOKEN" && ${#NEW_TOKEN} -le 4096 && "$NEW_TOKEN" != *[[:space:]]* ]] || fail 'Токены не совпали или формат неверен. Старый файл не менялся.'
    [[ "$kind" != telegram || "$NEW_TOKEN" =~ ^[1-9][0-9]{4,19}:[A-Za-z0-9_-]{30,128}$ ]] || fail 'Неверный формат Telegram-токена. Старый файл не менялся.'
    SECRET_DRAFT=$(mktemp "${target%/*}/.new-token.XXXXXXXX")
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

pin_record() {
    docker_local image inspect "$BOT_IMAGE" >/dev/null || return
    [[ "$AI_IMAGE" == none ]] || docker_local image inspect "$AI_IMAGE" >/dev/null || return
    docker_local tag "$BOT_IMAGE" "panel-admin-bot:checkpoint-${BOT_IMAGE#sha256:}" || return
    [[ "$AI_IMAGE" == none ]] || docker_local tag "$AI_IMAGE" "panel-admin-ai:checkpoint-${AI_IMAGE#sha256:}" || return
}

retag_record() {
    local bot_reference="panel-admin-bot:checkpoint-${BOT_IMAGE#sha256:}" ai_reference="panel-admin-ai:checkpoint-${AI_IMAGE#sha256:}"
    docker_local image inspect "$bot_reference" >/dev/null 2>&1 || bot_reference=$BOT_IMAGE
    [[ "$AI_IMAGE" == none ]] || docker_local image inspect "$ai_reference" >/dev/null 2>&1 || ai_reference=$AI_IMAGE
    docker_local image inspect "$bot_reference" >/dev/null || return
    [[ "$AI_IMAGE" == none ]] || docker_local image inspect "$ai_reference" >/dev/null || return
    docker_local tag "$bot_reference" panel-admin-bot:local || return
    [[ "$AI_IMAGE" == none ]] || docker_local tag "$ai_reference" panel-admin-ai:local || return
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
    pin_record || fail 'Принятые образы недоступны для закрепления. Обновление не начато, контейнеры не менялись.'
    [[ ! -e "$OPS/previous.env" && ! -L "$OPS/previous.env" ]] || private_file "$OPS/previous.env"
    cp -- "$OPS/active.env" "$OPS/previous.env"; chmod 0600 "$OPS/previous.env"
    printf '%s\n' "$target" > "$OPS/pending"
    git -C "$REPO" checkout --detach "$target" >/dev/null 2>&1
    if compose build "${SERVICES[@]}" && check_configuration; then
        printf 'Ревизия подготовлена. Работающие контейнеры не менялись. Следующий шаг: botctl apply\n'
    else
        retag_record || fail 'Подготовка не удалась, образы отката недоступны. Контейнеры не пересоздавались; исходники и pending сохранены для восстановления.'
        git -C "$REPO" checkout --detach "$REVISION" >/dev/null 2>&1 || fail 'Образы возвращены, но исходники вернуть не удалось. Контейнеры не менялись; pending сохранён.'
        rm -f -- "$OPS/pending"
        fail 'Подготовка не удалась: исходники и теги возвращены. Работающие контейнеры не менялись.'
    fi
}

prepare_rollback() {
    clean_checkout
    read_record "$OPS/previous.env"
    [[ "$AI_MODE" != true || "$AI_IMAGE" != none ]] || fail 'Предыдущая ревизия без ai. Сначала явно измените режим в settings.'
    git -C "$REPO" cat-file -e "$REVISION:apps/telegram-admin/botctl" || fail 'Для этой старой ревизии нужен ручной откат по инструкции.'
    retag_record || fail 'Образы отката недоступны. Контейнеры и исходники не менялись.'
    optional_service business stop; optional_service voice stop; optional_service media stop
    git -C "$REPO" checkout --detach "$REVISION" >/dev/null 2>&1
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

optional_service() {
    local kind=$1 action=$2 directory project service ids identifier details
    local -a arguments
    if [[ "$kind" == voice ]]; then directory=$APP; project=panel-admin-voice; service=voice; arguments=(-p "$project" --project-directory "$directory" -f "$APP/compose.voice.yaml");
    elif [[ "$kind" == media ]]; then directory="$REPO/apps/business"; project=panel-admin-media; service=media; arguments=(-p "$project" --project-directory "$directory" -f "$directory/compose.media.yaml");
    else directory="$REPO/apps/business"; project=panel-admin-business; service=portal; arguments=(-p "$project" --project-directory "$directory" --env-file "$directory/.env" -f "$directory/compose.yaml"); fi
    ids=$(docker_local ps -aq --filter "label=com.docker.compose.project=$project")
    local count=0
    for identifier in $ids; do
        count=$((count+1)); [[ "$count" -le 1 ]] || fail 'Несколько экземпляров дополнительного сервиса.'
        details=$(docker_local inspect --format '{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$identifier")
        [[ "$details" == "$service|$directory" ]] || fail 'Дополнительный проект принадлежит другой папке.'
    done
    if [[ "$action" == status ]]; then docker_local ps -a --filter "label=com.docker.compose.project=$project" --format 'table {{.Names}}\t{{.Status}}'; return; fi
    if [[ "$action" == stop ]]; then for identifier in $ids; do docker_local stop --time 45 "$identifier" >/dev/null; done; return; fi
    if [[ "$kind" == business && "$action" == settings ]]; then
        local business_draft
        DRAFT=$(mktemp "$OPS/business.XXXXXXXX")
        if [[ -e "$directory/.env" ]]; then private_file "$directory/.env"; cp -- "$directory/.env" "$DRAFT"; else cp -- "$directory/.env.example" "$DRAFT"; fi
        nano -- "$DRAFT" < /dev/tty > /dev/tty 2> /dev/tty
        business_draft=$DRAFT
        if check_file business "$business_draft"; then DRAFT=$business_draft; else rm -f -- "$business_draft"; return 1; fi
        chown 0:0 "$DRAFT"; chmod 0600 "$DRAFT"; mv -- "$DRAFT" "$directory/.env"; DRAFT=''; return
    fi
    if [[ "$kind" == business ]]; then
        check_file business "$directory/.env" || return
        [[ $(sed -n '/^SUPPORT_AI_ENABLED=true$/p' "$directory/.env") != SUPPORT_AI_ENABLED=true ]] || arguments+=(-f "$directory/compose.ai.yaml")
        [[ $(sed -n '/^PORTAL_PANEL_READ_ENABLED=true$/p' "$directory/.env") != PORTAL_PANEL_READ_ENABLED=true ]] || arguments+=(-f "$directory/compose.panel.yaml")
        [[ $(sed -n '/^SEARCH_ENABLED=true$/p' "$directory/.env") != SEARCH_ENABLED=true ]] || arguments+=(-f "$directory/compose.search.yaml")
    fi
    case "$action" in
        build) docker_local compose "${arguments[@]}" build ;;
        start) docker_local compose "${arguments[@]}" config --quiet; docker_local compose "${arguments[@]}" up -d --no-build --no-deps "$service" ;;
        account) [[ "$kind" == business && -n "$ids" ]] || fail 'Нужен запущенный кабинет.'; docker_local exec -it "$ids" node /app/apps/business/account-cli.mjs ;;
        *) fail 'Неизвестная операция дополнительного сервиса.' ;;
    esac
}

transfer_state() {
    local mode=$1 identifier revision business_ids business_id details volume label snapshot
    revision=$(git -C "$REPO" rev-parse HEAD)
    [[ "$revision" =~ ^[a-f0-9]{40}$ ]] || fail 'Некорректная ревизия.'
    if [[ "$mode" == export ]]; then
        clean_checkout; read_record "$OPS/active.env"
        [[ "$revision" == "$REVISION" && ! -e "$OPS/pending" ]] || fail 'Сначала завершите apply или rollback; снимок должен соответствовать работающей ревизии.'
        [[ -z "$BOT_ID" || $(docker_local inspect --format '{{.Image}}' "$BOT_ID") == "$BOT_IMAGE" ]] || fail 'Образ bot отличается от принятой версии.'
        [[ -z "$AI_ID" || $(docker_local inspect --format '{{.Image}}' "$AI_ID") == "$AI_IMAGE" ]] || fail 'Образ ai отличается от принятой версии.'
    fi
    local missing_kinds=''
    local -a mounts=()
    for identifier in bot ai business; do
        case "$identifier" in bot) volume=panel-admin-bot_bot-state ;; ai) volume=panel-admin-bot_ai-state ;; business) volume=panel-admin-business_business-state ;; esac
        if docker_local volume inspect "$volume" >/dev/null 2>&1; then
            label=$(docker_local volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "$volume")
            [[ "$label" == panel-admin-bot || ( "$identifier" == business && "$label" == panel-admin-business ) ]] || fail 'Том принадлежит другому проекту.'
            mounts+=(--mount "type=volume,src=$volume,dst=/source/$identifier$([[ "$mode" == restore ]] || printf ',readonly')")
        else
            missing_kinds+="$identifier,"
            mounts+=(--tmpfs "/source/$identifier:rw,uid=1000,gid=1000,size=1m")
        fi
    done
    business_ids=$(docker_local ps -aq --filter label=com.docker.compose.project=panel-admin-business)
    for business_id in $business_ids; do
        details=$(docker_local inspect --format '{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$business_id")
        [[ "$details" == "portal|$REPO/apps/business" ]] || fail 'Бизнес-проект принадлежит другой папке.'
    done
    [[ -z "$BOT_ID" ]] || docker_local stop --time 45 "$BOT_ID" >/dev/null
    [[ -z "$AI_ID" ]] || docker_local stop --time 15 "$AI_ID" >/dev/null
    for business_id in $business_ids; do docker_local stop --time 45 "$business_id" >/dev/null; done
    [[ ! -L "$OPS/backups" ]] || fail 'Недопустимая папка снимков.'
    mkdir -p -- "$OPS/backups"; chmod 0700 "$OPS/backups"
    if [[ "$mode" == export ]]; then
        snapshot=$(mktemp -d "$OPS/backups/backup.XXXXXXXX")
        chown 1000:1000 "$snapshot"; chmod 0700 "$snapshot"
    else
        snapshot="$OPS/backups/$2"
        [[ -d "$snapshot" && ! -L "$snapshot" ]] || fail 'Доверенный снимок не найден.'
    fi
    docker_local run --rm --pull never --network none --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges:true --memory 512m --memory-swap 512m --cpus 0.5 --pids-limit 32 --env "STATE_MISSING_KINDS=$missing_kinds" "${mounts[@]}" --mount "type=bind,src=$snapshot,dst=/snapshot$([[ "$mode" != restore ]] || printf ',readonly')" --entrypoint node panel-admin-bot:local /app/apps/telegram-admin/state-transfer.mjs "$mode" "$revision" || return
    printf 'Снимок: %s. Только состояние; без токенов/auth/приватных env. Получатели оставлены остановленными. Для обычного продолжения: ./botctl start.\n' "${snapshot##*/}"
}

apply_all() {
    check_configuration || return
    [[ ! -e "$REPO/apps/business/.env" ]] || check_file business "$REPO/apps/business/.env" || return
    optional_service business stop; optional_service voice stop; optional_service media stop
    apply_configuration
    if [[ -f "$APP/.env.extensions" && $(sed -n '/^VOICE_ENABLED=true$/p' "$APP/.env.extensions") == VOICE_ENABLED=true ]]; then optional_service voice build; optional_service voice start; fi
    if [[ -f "$REPO/apps/business/.env" && $(sed -n '/^PORTAL_ENABLED=true$/p' "$REPO/apps/business/.env") == PORTAL_ENABLED=true ]]; then
        optional_service business build
        if [[ $(sed -n '/^MEDIA_ENABLED=true$/p' "$REPO/apps/business/.env") == MEDIA_ENABLED=true ]]; then
            docker_local compose -p panel-admin-business --project-directory "$REPO/apps/business" --env-file "$REPO/apps/business/.env" -f "$REPO/apps/business/compose.yaml" create --no-build portal
            optional_service media build; optional_service media start
        fi
        optional_service business start
    fi
    optional_service voice status; optional_service media status; optional_service business status
    printf 'Выбранные модули применены. Проверьте их health и прикладные сценарии; защитные паузы не снимались.\n'
}

main() {
    APP=$1; shift
    local command=${1:-help}; shift || true
    [[ "$command" != help || $# != 0 ]] || { help_text; return; }
    case "$command" in status|adopt|build|check|start|apply|apply-all|stop|stop-all|config|settings|extensions|backup|rollback) [[ $# == 0 ]] || fail 'Лишние аргументы.' ;; business) [[ $# == 1 && "$1" =~ ^(settings|build|start|stop|status|account)$ ]] || fail 'Некорректная операция business.' ;; voice|media) [[ $# == 1 && "$1" =~ ^(build|start|stop|status)$ ]] || fail 'Некорректная операция worker.' ;; restore) [[ $# == 1 && "$1" =~ ^backup\.[A-Za-z0-9]{8}$ ]] || fail 'Используйте restore BACKUP_ID.' ;; logs) [[ $# -le 1 && "${1:-bot}" =~ ^(bot|ai)$ ]] || fail 'Используйте logs bot или logs ai.' ;; token) [[ $# == 1 && "$1" =~ ^(panel|telegram|write|search)$ ]] || fail 'Используйте token panel, telegram, write или search.' ;; update) [[ $# == 1 ]] || fail 'Используйте update FULL_SHA.' ;; init) ;; *) fail 'Неизвестная команда. Используйте help.' ;; esac
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
    if [[ "$command" == business || "$command" == voice || "$command" == media ]]; then optional_service "$command" "$1"; return; fi
    if [[ "$command" == apply-all ]]; then load_settings; apply_all; return; fi
    if [[ "$command" == stop-all ]]; then optional_service business stop; optional_service voice stop; optional_service media stop; [[ -z "$BOT_ID" ]] || docker_local stop --time 45 "$BOT_ID" >/dev/null; [[ -z "$AI_ID" ]] || docker_local stop --time 15 "$AI_ID" >/dev/null; return; fi
    if [[ "$command" == backup ]]; then transfer_state export; return; fi
    if [[ "$command" == restore ]]; then transfer_state restore "$1"; return; fi
    if [[ "$command" == extensions ]]; then
        DRAFT=$(mktemp "$OPS/extensions.XXXXXXXX")
        if [[ -e "$APP/.env.extensions" ]]; then private_file "$APP/.env.extensions"; cp -- "$APP/.env.extensions" "$DRAFT"; else cp -- "$APP/extensions.env.example" "$DRAFT"; fi
        nano -- "$DRAFT"
        local extensions_draft=$DRAFT
        if check_file extensions "$extensions_draft"; then DRAFT=$extensions_draft; else rm -f -- "$extensions_draft"; return 1; fi
        chmod 0600 "$DRAFT"; chown 0:0 "$DRAFT"; mv -- "$DRAFT" "$APP/.env.extensions"; DRAFT=''
        printf 'Дополнения сохранены; контейнеры не менялись. Используйте check и apply.\n'; return
    fi
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
