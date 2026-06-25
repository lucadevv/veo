#!/usr/bin/env bash
#
# boot-passenger-stack.sh · Arranque reusable del stack backend del PASAJERO (dev local).
#
# Levanta places(3013), identity(3091), trip(3092), dispatch(3093), fleet(3012),
# payment(3005 + gRPC 50055), rating(3010 + gRPC 50060) y public-bff(4001) desde sus
# `dist/main.js`, con el env de cada uno cargado desde un ÚNICO `env/<tier>.env` (GITIGNORED;
# config + secretos mergeados — convención env única del backend). Solo `example.env` queda tracked.
#
# RAÍZ DEL PROBLEMA QUE RESUELVE: identity, si no recibe JWT_PRIVATE_KEY_PEM, genera un keypair
# EFÍMERO en cada arranque; el public-bff, sin VEO_JWT_PUBLIC_PEM, genera OTRO. identity firma con
# uno y el BFF valida con otro → 401. Aquí el keypair ES256 (EC P-256) es PERSISTENTE y compartido:
#   - privada PKCS#8  → identity (JWT_PRIVATE_KEY_PEM)
#   - pública  SPKI   → public-bff (VEO_JWT_PUBLIC_PEM)
# Vive en dev-stack/secrets/*.pem (gitignored) y se inyecta en los env/development.env. Si no existe, se
# genera una vez y se reusa siempre (idempotente). Lo mismo el INTERNAL_IDENTITY_SECRET (HMAC) que
# comparten identity + places + bff.
#
# Idempotente: si un puerto ya está ocupado, lo reporta y NO duplica el proceso.
#
# Uso:
#   dev-stack/boot-passenger-stack.sh            # arranca lo que falte y espera health
#   dev-stack/boot-passenger-stack.sh stop       # mata los procesos que arrancó (por PID file)
#   dev-stack/boot-passenger-stack.sh restart     # stop + start
#   dev-stack/boot-passenger-stack.sh status      # estado de puertos/health
#
set -euo pipefail

# ── Paths ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SECRETS_DIR="$SCRIPT_DIR/secrets"
LOGS_DIR="$SCRIPT_DIR/logs"
PIDS_DIR="$SCRIPT_DIR/.pids"
JWT_PRIV_PEM="$SECRETS_DIR/jwt-es256-private.pkcs8.pem"
JWT_PUB_PEM="$SECRETS_DIR/jwt-es256-public.spki.pem"
INTERNAL_SECRET_FILE="$SECRETS_DIR/internal-identity-secret.txt"
# Token PÚBLICO de Mapbox (pk) para el modo VEO_MAPS_MODE=mapbox del BFF. Persistente (gitignored).
MAPBOX_TOKEN_FILE="$SECRETS_DIR/mapbox-access-token.txt"
# Credenciales ProntoPaga (VEO_PAYMENT_MODE=prontopaga). Persistentes (gitignored). En dev se siembran
# con las de PRUEBA PÚBLICAS del sandbox (docs.prontopaga.com/docs/first-steps); en prod se pegan las reales.
PRONTOPAGA_SECRET_FILE="$SECRETS_DIR/prontopaga-secret-key.txt"
PRONTOPAGA_TOKEN_FILE="$SECRETS_DIR/prontopaga-api-token.txt"
# Defaults de PRUEBA PÚBLICOS (no son secretos reales): se siembran si los files no existen.
PRONTOPAGA_SECRET_DEFAULT="01JNH2SBC5Z2CM1PWQXM2C1XK9"
PRONTOPAGA_TOKEN_DEFAULT="caff446438560a48438e0b49e5a6a0870ac5624b9f9ce1577858595d1a8ba1ec"

IDENTITY_DIR="$ROOT_DIR/services/identity-service"
PLACES_DIR="$ROOT_DIR/services/places-service"
TRIP_DIR="$ROOT_DIR/services/trip-service"
DISPATCH_DIR="$ROOT_DIR/services/dispatch-service"
FLEET_DIR="$ROOT_DIR/services/fleet-service"
PAYMENT_DIR="$ROOT_DIR/services/payment-service"
RATING_DIR="$ROOT_DIR/services/rating-service"
NOTIFICATION_DIR="$ROOT_DIR/services/notification-service"
BFF_DIR="$ROOT_DIR/services/bff/public-bff"

# Credenciales de PUSH — STACK AUTOCONTENIDO (no depende del path hermano ../config en runtime).
#   - El notification consume SIEMPRE las copias in-repo de secrets/ (gitignored), no ../config.
#   - ../config queda SOLO como FUENTE de la siembra inicial (one-shot, en ensure_secrets). Tras la
#     primera copia, el stack arranca aunque ../config no exista.
#   - APNs .p8 (riel iOS directo, opcional) y FCM service-account JSON (riel push default).
# Si la copia in-repo del JSON FCM existe, el notification arranca en VEO_PUSH_MODE=live; si no, sandbox.
WORKSPACE_CONFIG_DIR="$ROOT_DIR/../config"          # solo FUENTE de la copia inicial (seed)
APNS_P8_FILE="$SECRETS_DIR/apns-key.p8"             # copia in-repo (gitignored)
FCM_SA_JSON_FILE="$SECRETS_DIR/fcm-service-account.json"  # copia in-repo (gitignored)

mkdir -p "$SECRETS_DIR" "$LOGS_DIR" "$PIDS_DIR"

c_green() { printf '\033[32m%s\033[0m\n' "$*"; }
c_red()   { printf '\033[31m%s\033[0m\n' "$*"; }
c_blue()  { printf '\033[36m%s\033[0m\n' "$*"; }
log()     { printf '  %s\n' "$*"; }

# ── 1. Keypair JWT ES256 (EC P-256) PERSISTENTE + HMAC interno ───────────────
ensure_secrets() {
  c_blue "[secrets] keypair JWT ES256 (EC P-256) + HMAC interno"
  if [[ -s "$JWT_PRIV_PEM" && -s "$JWT_PUB_PEM" ]]; then
    log "keypair existente, reuso: $JWT_PRIV_PEM"
  else
    log "generando keypair persistente…"
    openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$JWT_PRIV_PEM" 2>/dev/null
    openssl pkey -in "$JWT_PRIV_PEM" -pubout -out "$JWT_PUB_PEM" 2>/dev/null
    chmod 600 "$JWT_PRIV_PEM"
    log "keypair generado: $JWT_PRIV_PEM (+ .spki público)"
  fi
  if [[ -s "$INTERNAL_SECRET_FILE" ]]; then
    log "INTERNAL_IDENTITY_SECRET existente, reuso"
  else
    openssl rand -hex 32 > "$INTERNAL_SECRET_FILE"
    chmod 600 "$INTERNAL_SECRET_FILE"
    log "INTERNAL_IDENTITY_SECRET generado"
  fi

  # Token Mapbox (pk) para VEO_MAPS_MODE=mapbox del BFF. Vive SOLO en este archivo gitignored
  # (NUNCA hardcodeado en el script tracked). Si falta, pegá tu pk en $MAPBOX_TOKEN_FILE;
  # sin él el BFF degrada honestamente al motor local de geocoding.
  if [[ ! -s "$MAPBOX_TOKEN_FILE" ]]; then
    : > "$MAPBOX_TOKEN_FILE"
    chmod 600 "$MAPBOX_TOKEN_FILE"
    log "FALTA el pk de Mapbox → pegalo en $MAPBOX_TOKEN_FILE (mientras, el BFF usa el geocoder local)"
  else
    log "MAPBOX_ACCESS_TOKEN existente, reuso"
  fi

  # Credenciales ProntoPaga: si faltan, sembrar las de PRUEBA PÚBLICAS del sandbox (dev). En prod
  # se reemplaza el contenido de estos files por las reales (gitignored, NUNCA en el script tracked).
  if [[ ! -s "$PRONTOPAGA_SECRET_FILE" ]]; then
    printf '%s' "$PRONTOPAGA_SECRET_DEFAULT" > "$PRONTOPAGA_SECRET_FILE"; chmod 600 "$PRONTOPAGA_SECRET_FILE"
    log "PRONTOPAGA_SECRET_KEY sembrada con la de prueba PÚBLICA (cambiá $PRONTOPAGA_SECRET_FILE en prod)"
  else
    log "PRONTOPAGA_SECRET_KEY existente, reuso"
  fi
  if [[ ! -s "$PRONTOPAGA_TOKEN_FILE" ]]; then
    printf '%s' "$PRONTOPAGA_TOKEN_DEFAULT" > "$PRONTOPAGA_TOKEN_FILE"; chmod 600 "$PRONTOPAGA_TOKEN_FILE"
    log "PRONTOPAGA_API_TOKEN sembrado con el de prueba PÚBLICO (cambiá $PRONTOPAGA_TOKEN_FILE en prod)"
  else
    log "PRONTOPAGA_API_TOKEN existente, reuso"
  fi

  # Siembra ONE-SHOT de las credenciales de PUSH al secrets/ del repo (gitignored). Hace el stack
  # AUTOCONTENIDO: copia desde ../config SOLO si la copia in-repo no existe; después usa siempre la
  # copia local. Si ../config tampoco está, degrada honesto (push en sandbox). Idempotente.
  if [[ ! -s "$FCM_SA_JSON_FILE" ]]; then
    local _src_fcm=""
    for _sa in "$WORKSPACE_CONFIG_DIR"/firebase/*.json; do [[ -s "$_sa" ]] && { _src_fcm="$_sa"; break; }; done
    if [[ -n "$_src_fcm" ]]; then
      cp "$_src_fcm" "$FCM_SA_JSON_FILE"; chmod 600 "$FCM_SA_JSON_FILE"
      log "FCM service-account copiado al repo (gitignored): ${FCM_SA_JSON_FILE#"$ROOT_DIR"/}"
    else
      c_red "[push] sin FCM service-account (ni copia in-repo ni en ../config) → push en SANDBOX"
    fi
  else
    log "FCM service-account in-repo presente, reuso (no toco ../config)"
  fi
  if [[ ! -s "$APNS_P8_FILE" && -s "$WORKSPACE_CONFIG_DIR/app-ios/AuthKey_TGZXNZ7CU8.p8" ]]; then
    cp "$WORKSPACE_CONFIG_DIR/app-ios/AuthKey_TGZXNZ7CU8.p8" "$APNS_P8_FILE"; chmod 600 "$APNS_P8_FILE"
    log "APNs .p8 copiado al repo (gitignored): ${APNS_P8_FILE#"$ROOT_DIR"/}"
  fi

  local priv pub secret mapbox_token pp_secret pp_token
  priv="$(cat "$JWT_PRIV_PEM")"
  pub="$(cat "$JWT_PUB_PEM")"
  secret="$(cat "$INTERNAL_SECRET_FILE")"
  mapbox_token="$(cat "$MAPBOX_TOKEN_FILE")"
  pp_secret="$(cat "$PRONTOPAGA_SECRET_FILE")"
  pp_token="$(cat "$PRONTOPAGA_TOKEN_FILE")"

  # Convención env ÚNICA: inyecta los secretos en el env/development.env de cada servicio (config +
  # secretos mergeados, GITIGNORED). Append-if-absent / replace-if-empty por clave (idempotente):
  # NO pisa la config ya presente y NO duplica claves. Helper compartido: dev-stack/lib/upsert-env.mjs.
  local UPSERT="node $SCRIPT_DIR/lib/upsert-env.mjs"

  $UPSERT "$IDENTITY_DIR/env/development.env" \
    "JWT_PRIVATE_KEY_PEM=$priv" "JWT_PUBLIC_KEY_PEM=$pub" "INTERNAL_IDENTITY_SECRET=$secret"

  $UPSERT "$BFF_DIR/env/development.env" \
    "VEO_JWT_PUBLIC_PEM=$pub" "VEO_INTERNAL_IDENTITY_SECRET=$secret" "MAPBOX_ACCESS_TOKEN=$mapbox_token"

  $UPSERT "$PLACES_DIR/env/development.env"   "INTERNAL_IDENTITY_SECRET=$secret"
  $UPSERT "$TRIP_DIR/env/development.env"     "INTERNAL_IDENTITY_SECRET=$secret"
  $UPSERT "$DISPATCH_DIR/env/development.env" "INTERNAL_IDENTITY_SECRET=$secret"
  $UPSERT "$FLEET_DIR/env/development.env"    "INTERNAL_IDENTITY_SECRET=$secret"

  $UPSERT "$PAYMENT_DIR/env/development.env" \
    "INTERNAL_IDENTITY_SECRET=$secret" "PRONTOPAGA_SECRET_KEY=$pp_secret" "PRONTOPAGA_API_TOKEN=$pp_token"

  $UPSERT "$RATING_DIR/env/development.env"   "INTERNAL_IDENTITY_SECRET=$secret"

  # notification: HMAC interno + (opcional) APNs .p8 directo + RUTA del FCM service-account JSON. Solo se
  # inyecta lo que exista (si falta el JSON, el push queda en sandbox — degradación honesta en cmd_start).
  local notif_kv=( "INTERNAL_IDENTITY_SECRET=$secret" )
  [[ -s "$APNS_P8_FILE" ]] && notif_kv+=( "APNS_KEY_P8=$(cat "$APNS_P8_FILE")" )
  [[ -s "$FCM_SA_JSON_FILE" ]] && notif_kv+=( "GOOGLE_APPLICATION_CREDENTIALS=$FCM_SA_JSON_FILE" )
  $UPSERT "$NOTIFICATION_DIR/env/development.env" "${notif_kv[@]}"

  c_green "[secrets] OK · keypair + HMAC inyectados en los 9 env/development.env (env-única, idempotente)"
}

# ── Helpers de puerto / proceso ──────────────────────────────────────────────
port_in_use() { lsof -ti "tcp:$1" -sTCP:LISTEN >/dev/null 2>&1; }
pid_on_port() { lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null | head -1; }

# Carga env/<APP_ENV>.{env,env} de un servicio y lo exporta (regla ENTORNOS §5: carga según
# APP_ENV). Tier por defecto: development (= local-nativo). `set -a` exporta toda var asignada;
# soporta valores multilínea entre comillas (los PEM).
load_env() {
  local svc_dir="$1"
  local tier="${APP_ENV:-development}"
  set -a
  export APP_ENV="$tier"   # el servicio ve su tier en process.env
  # Convención env ÚNICA: un solo env/<tier>.env por servicio (config + secretos mergeados, GITIGNORED).
  # shellcheck disable=SC1090
  [[ -f "$svc_dir/env/${tier}.env" ]] && source "$svc_dir/env/${tier}.env"
  set +a
}

# start_service <nombre> <dir> <http_port> [extra_env_kv...]
# Arranca node dist/main.js en background con el env del servicio cargado en un subshell aislado.
start_service() {
  local name="$1" dir="$2" http_port="$3"; shift 3
  local logf="$LOGS_DIR/$name.log"
  local pidf="$PIDS_DIR/$name.pid"

  if port_in_use "$http_port"; then
    c_blue "[$name] puerto $http_port YA ocupado (pid $(pid_on_port "$http_port")) — no arranco de nuevo (idempotente)"
    return 0
  fi
  # En WATCH (VEO_WATCH=1) NO exigimos dist/main.js: `nest start --watch` compila al vuelo desde src.
  # En modo normal SÍ — sin dist no hay binario que bootear.
  if [[ "${VEO_WATCH:-0}" != "1" && ! -f "$dir/dist/main.js" ]]; then
    c_red "[$name] FALTA $dir/dist/main.js — construí el servicio antes de bootear"
    return 1
  fi

  if [[ "${VEO_WATCH:-0}" == "1" ]]; then
    c_blue "[$name] arrancando en WATCH (nest start --watch, HTTP :$http_port) → log: $logf"
  else
    c_blue "[$name] arrancando (HTTP :$http_port) → log: $logf"
  fi
  (
    cd "$dir"
    load_env "$dir"
    # Overrides explícitos pasados por argumento (kv 'VAR=value').
    for kv in "$@"; do export "${kv?}"; done
    # Migraciones automáticas al boot (idempotente, P0 infra): aplica las PENDIENTES antes de
    # arrancar. Mata el drift de schema — un servicio con migración nueva sin aplicar crashea en
    # runtime (P2022/P3009). Si falla (drift corrupto / DB inalcanzable) NO arranca: fail-fast.
    if [[ -d prisma/migrations ]]; then
      npx prisma migrate deploy || { c_red "[$name] migrate deploy FALLÓ — NO arranco (revisá $logf)"; exit 1; }
    fi
    # WATCH: el script `dev` del paquete (= nest start --watch) recompila y reinicia ante cada cambio
    # de SRC. Normal: el binario ya compilado. El `down` de veo.sh reapea los watchers (pkill 'nest start').
    if [[ "${VEO_WATCH:-0}" == "1" ]]; then
      exec pnpm run dev
    else
      exec node dist/main.js
    fi
  ) >"$logf" 2>&1 &
  echo $! > "$pidf"
  log "pid $(cat "$pidf")"
}

# wait_health <nombre> <url> [timeout_s]
wait_health() {
  local name="$1" url="$2" timeout="${3:-40}" i=0
  printf '  [%s] esperando health %s ' "$name" "$url"
  while (( i < timeout )); do
    if curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null; then
      c_green "OK"
      return 0
    fi
    printf '.'
    sleep 1
    ((i++))
  done
  c_red "TIMEOUT (${timeout}s) — revisá $LOGS_DIR/$name.log"
  return 1
}

cmd_start() {
  c_blue "== boot-passenger-stack :: START =="
  ensure_secrets

  # Orden: places + identity + trip + dispatch (downstream) → bff (los agrega).
  start_service "places"   "$PLACES_DIR"   3013
  start_service "identity" "$IDENTITY_DIR" 3091
  start_service "trip"     "$TRIP_DIR"     3092
  start_service "dispatch" "$DISPATCH_DIR" 3093
  start_service "fleet"    "$FLEET_DIR"    3012
  start_service "payment"  "$PAYMENT_DIR"  3005
  start_service "rating"   "$RATING_DIR"   3010

  # notification: PUSH en 'live' SOLO si está el service-account JSON de FCM; si no, 'sandbox' (loguea).
  # Así el registro del device-token funciona siempre; el ENVÍO real se habilita al caer el JSON (sin tocar código).
  local push_mode="sandbox"
  if [[ -s "$FCM_SA_JSON_FILE" ]]; then
    push_mode="live"
    log "[notification] FCM service-account presente → VEO_PUSH_MODE=live"
  else
    c_blue "[notification] falta $FCM_SA_JSON_FILE → VEO_PUSH_MODE=sandbox (registro OK; el envío real espera el JSON)"
  fi
  # Seed IDEMPOTENTE de plantillas (upsert por key). El engine renderiza el push/SMS/email desde la
  # tabla `templates`; sin seed, TODO push falla con "Plantilla no encontrada". Best-effort: si falla,
  # avisa pero no aborta el boot. Solo corre si el servicio se va a levantar (puerto libre).
  if ! port_in_use 3008; then
    c_blue "[notification] seed de plantillas (idempotente)…"
    ( cd "$NOTIFICATION_DIR" && load_env "$NOTIFICATION_DIR" && pnpm -s db:seed ) >/dev/null 2>&1 \
      && log "[notification] plantillas seedeadas" \
      || c_red "[notification] seed de plantillas falló — los push no renderizarán (revisá Postgres)"
  fi
  start_service "notification" "$NOTIFICATION_DIR" 3008 "VEO_PUSH_MODE=$push_mode"

  start_service "bff"      "$BFF_DIR"      4001

  echo
  wait_health "identity" "http://localhost:3091/health" 45
  # places ahora excluye health del prefijo (/health, como trip/dispatch/identity/payment/rating).
  wait_health "places"   "http://localhost:3013/health" 45
  # trip/dispatch/fleet montan health en /health (FUERA del prefijo /api/v1, como el bff).
  wait_health "trip"     "http://localhost:3092/health" 45
  wait_health "dispatch" "http://localhost:3093/health" 45
  # fleet ahora excluye health del prefijo (/health, como trip/dispatch/identity/payment/rating).
  wait_health "fleet"    "http://localhost:3012/health" 45
  # payment y rating excluyen health del prefijo (/health, como trip/dispatch/identity).
  wait_health "payment"  "http://localhost:3005/health"        45
  wait_health "rating"   "http://localhost:3010/health"        45
  # notification monta health en /health (excluido del prefijo /api/v1, uniforme con el resto).
  wait_health "notification" "http://localhost:3008/health"    45
  # identity ahora monta health en /health (FUERA del prefijo /api/v1, como trip/dispatch/bff), por lo
  # que el readiness del BFF (que prueba el downstream identity en /health sin prefijo) ya da 200.
  # Igual esperamos el LIVENESS del BFF (/health/live) para confirmar que el proceso está ARRIBA.
  wait_health "bff"      "http://localhost:4001/health/live"   45

  echo
  c_green "== stack del pasajero ARRIBA =="
  log "identity : http://localhost:3091  (gRPC 50051)  · docs /docs"
  log "places   : http://localhost:3013  (gRPC 50063)  · docs /docs"
  log "payment  : http://localhost:3005  (gRPC 50055)  · health /health   · cobro trip.completed (sandbox)"
  log "rating   : http://localhost:3010  (gRPC 50060)  · health /health"
  log "notif    : http://localhost:3008  · health /health   · push FCM (device-token registry)"
  log "bff      : http://localhost:4001  · docs /docs   · health /health"
  log "logs     : $LOGS_DIR/{identity,places,bff,payment,rating}.log"
  log "código de verificación de correo (sandbox) → $LOGS_DIR/identity.log"
}

cmd_stop() {
  c_blue "== boot-passenger-stack :: STOP =="
  for name in bff notification rating payment fleet dispatch trip identity places; do
    local pidf="$PIDS_DIR/$name.pid"
    if [[ -f "$pidf" ]]; then
      local pid; pid="$(cat "$pidf")"
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null && log "[$name] matado (pid $pid)"
      else
        log "[$name] pid $pid ya no corre"
      fi
      rm -f "$pidf"
    else
      log "[$name] sin pid file (no lo arranqué yo)"
    fi
  done
}

cmd_status() {
  c_blue "== boot-passenger-stack :: STATUS =="
  for entry in "identity:3091:http://localhost:3091/health" \
               "places:3013:http://localhost:3013/health" \
               "payment:3005:http://localhost:3005/health" \
               "rating:3010:http://localhost:3010/health" \
               "notification:3008:http://localhost:3008/health" \
               "bff:4001:http://localhost:4001/health/live"; do
    IFS=: read -r name port url <<<"$entry"
    url="${entry#*:*:}"
    if port_in_use "$port"; then
      if curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null; then
        c_green "[$name] :$port UP + health OK"
      else
        c_red "[$name] :$port ocupado pero health NO responde"
      fi
    else
      log "[$name] :$port libre (apagado)"
    fi
  done
}

case "${1:-start}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status)  cmd_status ;;
  *) c_red "uso: $0 [start|stop|restart|status]"; exit 1 ;;
esac
