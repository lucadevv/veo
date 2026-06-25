#!/usr/bin/env bash
#
# veo.sh · IGNICIÓN + APAGADO + TABLERO del stack de dev del monorepo VEO.
# ────────────────────────────────────────────────────────────────────────────
# La analogía del dueño: "prendo el carro → arrancan TODOS los sistemas, y el
# tablero me dice qué falla". Esto es ESO: UNA forma canónica de levantar,
# apagar y observar el backend. Mata el caos de hoy (arranques heterogéneos,
# procesos huérfanos imposibles de matar limpio, migraciones a mano, logs
# cazados archivo por archivo).
#
# ── MODELO DE 2 CAPAS ───────────────────────────────────────────────────────
#   Capa 1 · INFRA (docker):   postgres :5433, redis :6379, kafka :9094,
#                              minio :9002 — corren en contenedores (compose).
#                              veo.sh NUNCA las tumba salvo `down --infra`.
#   Capa 2 · SERVICIOS (nativos): los 14 microservicios NestJS + 3 BFFs corren
#                              como procesos node nativos (dist/main.js), más
#                              biometric (Python/uvicorn) y tracking (Go).
#
# ── SUBCOMANDOS ─────────────────────────────────────────────────────────────
#   up                 Ignición completa: infra(wait healthy) → secrets →
#                      build(packages PRIMERO) → migrate deploy → boot uniforme
#                      → tablero. Idempotente: lo ya arriba no se duplica.
#   down [--infra]     Apagado LIMPIO y robusto en capas (pidfiles → puertos →
#                      pkill por patrón). Con --infra además baja los contenedores.
#   status             El TABLERO: una fila por servicio (puerto, health, pid,
#                      último error de log, dist ¿fresco?) + infra docker.
#   monitor            El ESCÁNER EN VIVO: sigue los logs de los 18 servicios en
#                      tiempo real y muestra SOLO los errores en el momento que pasan.
#   restart <svc>      down de ESE servicio (pidfile/puerto) + build + boot.
#   logs <svc> [-f]    tail (o tail -f con -f) de dev-stack/logs/<svc>.log.
#   migrate            Solo el paso de migraciones (prisma migrate deploy) — seguro/idempotente.
#
# REGLA DE PUERTOS (del dueño): si un puerto está ocupado por algo ajeno, se
# REPORTA — JAMÁS se salta a otro puerto en silencio.
# ────────────────────────────────────────────────────────────────────────────
set -uo pipefail

# ── Paths ───────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOGS_DIR="$SCRIPT_DIR/logs"
# Reusamos el MISMO registro de PIDs que ya escriben boot-passenger-stack.sh y
# boot-extra-services.sh (dev-stack/.pids). No inventamos un directorio nuevo
# para no fragmentar el registro y poder matar TODO lo que arrancó cualquiera.
PIDS_DIR="$SCRIPT_DIR/.pids"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
BIO_VENV="$ROOT_DIR/services/biometric-service/.venv"

mkdir -p "$LOGS_DIR" "$PIDS_DIR"

# ── Colores (solo si la terminal los soporta) ────────────────────────────────
if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  C_RESET=$'\033[0m'; C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YEL=$'\033[33m'
  C_BLUE=$'\033[36m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
else
  C_RESET=''; C_GREEN=''; C_RED=''; C_YEL=''; C_BLUE=''; C_DIM=''; C_BOLD=''
fi
green() { printf '%s%s%s\n' "$C_GREEN" "$*" "$C_RESET"; }
red()   { printf '%s%s%s\n' "$C_RED" "$*" "$C_RESET"; }
yel()   { printf '%s%s%s\n' "$C_YEL" "$*" "$C_RESET"; }
blue()  { printf '%s%s%s\n' "$C_BLUE" "$*" "$C_RESET"; }
log()   { printf '  %s\n' "$*"; }
hdr()   { printf '\n%s== %s ==%s\n' "$C_BOLD$C_BLUE" "$*" "$C_RESET"; }

# ── MAPA CANÓNICO DE SERVICIOS ────────────────────────────────────────────────
# Una sola fuente de verdad: "<svc>|<port>|<dir-relativo>|<kind>|<health-path>".
#   svc          → nombre lógico (== nombre de log/pidfile, para ser uniforme).
#   port         → puerto HTTP del servicio (regla de puertos del dueño).
#   dir          → ruta relativa a ROOT_DIR del paquete del servicio.
#   kind         → node | python | go  (define cómo se buildea/arranca).
#   health-path  → ruta de health (todos exponen /health fuera del prefijo).
# OJO: el public-bff se registra como "bff" porque ASÍ lo nombran los boot
# scripts existentes en logs/.pids — mantenemos ese nombre para no fragmentar.
SERVICES=(
  "identity|3091|services/identity-service|node|/health"
  "trip|3092|services/trip-service|node|/health"
  "dispatch|3093|services/dispatch-service|node|/health"
  "payment|3005|services/payment-service|node|/health"
  "panic|3006|services/panic-service|node|/health"
  "media|3007|services/media-service|node|/health"
  "notification|3008|services/notification-service|node|/health"
  "audit|3009|services/audit-service|node|/api/v1/health"
  "rating|3010|services/rating-service|node|/health"
  "share|3011|services/share-service|node|/api/v1/health"
  "fleet|3012|services/fleet-service|node|/health"
  "places|3013|services/places-service|node|/health"
  "chat|3014|services/chat-service|node|/health"
  "biometric|3015|services/biometric-service|python|/health"
  "tracking|3004|services/tracking-service|go|/health"
  "bff|4001|services/bff/public-bff|node|/health/live"
  "driver-bff|4002|services/bff/driver-bff|node|/health"
  "admin-bff|4003|services/bff/admin-bff|node|/health"
)

# Infra docker: "<label>|<container>|<port>".
# clickhouse (histórico GPS) y mosquitto (MQTT, ingesta GPS del driver) son OBLIGATORIOS para tracking:
# tracking arranca su consumer MQTT ANTES del HTTP y hace os.Exit(1) si no conecta al broker (:1883),
# así que sin mosquitto el :3004 NUNCA bindea. clickhouse:9000 = protocolo nativo (no el 8123 HTTP).
INFRA=(
  "postgres|veo-postgres|5433"
  "redis|veo-redis|6379"
  "kafka|veo-kafka|9094"
  "minio|veo-minio|9002"
  "clickhouse|veo-clickhouse|9000"
  "mosquitto|veo-mosquitto|1883"
)

# Accessors sobre una línea del mapa (svc_field <line> <index 1..5>).
svc_field() { printf '%s' "$1" | cut -d'|' -f"$2"; }
# Busca la línea de un servicio por nombre. Devuelve "" si no existe.
svc_line() {
  local want="$1" line
  for line in "${SERVICES[@]}"; do
    [[ "$(svc_field "$line" 1)" == "$want" ]] && { printf '%s' "$line"; return 0; }
  done
  return 1
}

# ── Helpers de puerto / proceso ───────────────────────────────────────────────
port_in_use() { lsof -ti "tcp:$1" -sTCP:LISTEN >/dev/null 2>&1; }
pid_on_port() { lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null | head -1; }

# health_code <url> → imprime el HTTP status (000 si no respondió).
health_code() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$1" 2>/dev/null || printf '000'
}

# Health probe MULTI-PATH. No todos los servicios exponen /health: varios montan
# un prefijo global (/api/v1) y el health real vive en /api/v1/health (confirmado:
# audit:3009 y share:3011 dan 404 en /health pero 200 en /api/v1/health). Otros
# (tracking Go, public-bff) usan /health/live o /health/ready.
# Probamos EN ORDEN hasta el primer código "vivo" (2xx o 401/403 = auth-gated),
# y devolvemos ESE código. Si ninguno da vivo, devolvemos el código del último
# intento (el más informativo: típicamente 404, o 000 si nada respondió).
# Imprime "<http_code>".
HEALTH_PATHS=(/health /api/v1/health /health/live /health/ready)
health_probe() {
  local base="$1" primary="${2:-}" p code last="000"
  # Probá PRIMERO el path DECLARADO del servicio ($health del mapa), si lo hay: los servicios con prefijo
  # global (audit/share → /api/v1/health) dan su 200 sin pegarle antes a /health, que logueaba un 404 espurio
  # en cada probe. Después, fallback al multi-path por robustez (si el declarado cambió o quedó vacío).
  for p in "$primary" "${HEALTH_PATHS[@]}"; do
    [[ -z "$p" ]] && continue
    code="$(health_code "${base}${p}")"
    case "$code" in
      2*|401|403) printf '%s' "$code"; return 0 ;;  # vivo (o auth-gated) → cortamos.
    esac
    [[ "$code" != "000" ]] && last="$code"  # guardamos el último código real (no 000).
  done
  printf '%s' "$last"
}

# ── 1. INFRA (docker) — levantar + esperar healthy ────────────────────────────
# clickhouse + mosquitto incluidos: tracking-service los necesita (histórico GPS + ingesta MQTT). Ninguno
# de los dos trae healthcheck en el compose ⇒ el wait cae al ping TCP del puerto (ya soportado abajo).
INFRA_SERVICES_COMPOSE=(postgres redis kafka minio clickhouse mosquitto)

infra_up_and_wait() {
  hdr "INFRA (docker)"
  if ! command -v docker >/dev/null 2>&1; then
    red "  docker no está en PATH — la infra (postgres/redis/kafka/minio) es OBLIGATORIA. Instalá Docker."
    return 1
  fi
  blue "  levantando contenedores: ${INFRA_SERVICES_COMPOSE[*]}"
  if ! docker compose -f "$COMPOSE_FILE" up -d "${INFRA_SERVICES_COMPOSE[@]}"; then
    red "  'docker compose up -d' FALLÓ — revisá el daemon de docker y $COMPOSE_FILE"
    return 1
  fi

  # Esperar healthy. postgres/redis/minio tienen healthcheck en el compose; kafka
  # NO (la imagen apache/kafka no trae uno), así que para kafka hacemos un ping
  # TCP al puerto 9094. Para los demás leemos docker inspect .State.Health.
  local timeout=60 line label container port i ok
  for line in "${INFRA[@]}"; do
    IFS='|' read -r label container port <<<"$line"
    printf '  [%s] esperando healthy ' "$label"
    i=0; ok=0
    while (( i < timeout )); do
      local hs
      hs="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || echo missing)"
      if [[ "$hs" == "healthy" ]]; then ok=1; break; fi
      if [[ "$hs" == "none" || "$hs" == "missing" ]]; then
        # Sin healthcheck (kafka) o aún sin estado: caemos a un ping TCP al puerto.
        if nc -z localhost "$port" >/dev/null 2>&1 || port_in_use "$port"; then ok=1; break; fi
      fi
      printf '.'; sleep 1; ((i++))
    done
    if (( ok )); then green "OK"; else
      red "TIMEOUT (${timeout}s) — '$container' no está healthy. Revisá: docker logs $container"
      return 1
    fi
  done
  green "  infra OK (postgres redis kafka minio clickhouse mosquitto)"
}

# ── 2. SECRETS ────────────────────────────────────────────────────────────────
gen_secrets() {
  hdr "SECRETS"
  if [[ -x "$SCRIPT_DIR/gen-missing-secrets.sh" || -f "$SCRIPT_DIR/gen-missing-secrets.sh" ]]; then
    # gen-missing-secrets requiere que los secretos COMPARTIDOS (jwt/hmac) ya
    # existan; los crea boot-passenger-stack (ensure_secrets). Por eso lo
    # corremos best-effort: si falla, avisa pero no aborta (boot-passenger los
    # generará). Idempotente.
    if bash "$SCRIPT_DIR/gen-missing-secrets.sh"; then
      green "  secretos extra inyectados (idempotente)"
    else
      yel "  gen-missing-secrets devolvió error (probable: faltan los secretos base; boot-passenger los genera). Sigo."
    fi
  else
    yel "  no encontré gen-missing-secrets.sh — sigo (boot-passenger genera los base)"
  fi
}

# ── 3. BUILD ──────────────────────────────────────────────────────────────────
# packages PRIMERO (evita el skew de @veo/* que rompió el stack hoy), luego los
# servicios. Tolera que un build falle SIN abortar todo: el dist viejo igual
# puede bootear. Reporta cuáles fallaron.
build_all() {
  hdr "BUILD"
  blue "  [1/2] packages (@veo/*) — PRIMERO para evitar skew de tipos"
  if pnpm -r --filter "./packages/*" build; then
    green "  packages OK"
  else
    red "  ALGÚN package falló su build — esto SÍ es grave (los servicios dependen de @veo/*)."
    red "  Reportado; sigo igual porque el dist viejo de los servicios puede bootear, pero REVISÁ esto."
  fi

  blue "  [2/2] servicios + BFFs"
  # turbo no está en PATH global → usamos 'pnpm exec turbo'. --continue hace que
  # un servicio con spec roto NO aborte el resto; capturamos el código y el
  # resumen para reportar honesto.
  local build_log="$LOGS_DIR/_build.log"
  if pnpm exec turbo run build --filter="./services/*" --filter="./services/bff/*" --continue 2>&1 | tee "$build_log"; then
    green "  servicios OK"
  else
    red "  ALGUNOS servicios fallaron su build (turbo --continue siguió con el resto)."
    # turbo imprime líneas tipo "<pkg>:build: ..." con error; rescatamos los paquetes fallidos.
    local failed
    failed="$(rg -No '^([^:]+):build' "$build_log" 2>/dev/null | sort -u | sed 's/:build//' || true)"
    if [[ -n "${failed:-}" ]]; then
      yel "  paquetes que ejecutaron build (revisá cuáles con error en $build_log):"
      printf '    %s\n' "$failed"
    fi
    yel "  Su dist viejo (si existe) igual booteará — el tablero marcará 'rebuild' donde el dist quedó stale."
  fi
}

# ── 4. MIGRACIONES (prisma migrate deploy) ────────────────────────────────────
# Para CADA servicio node con prisma/schema.prisma, corre 'prisma migrate deploy'
# con su DATABASE_URL (del env/development.env). Idempotente. Reporta resultado.
migrate_all() {
  hdr "MIGRACIONES (prisma migrate deploy)"
  local line svc dir kind ok=0 fail=0
  for line in "${SERVICES[@]}"; do
    IFS='|' read -r svc port dir kind health <<<"$line"
    [[ "$kind" == "node" ]] || continue
    [[ -f "$ROOT_DIR/$dir/prisma/schema.prisma" ]] || continue
    printf '  [%s] migrate deploy … ' "$svc"
    local out
    if out="$(
      cd "$ROOT_DIR/$dir" || exit 1
      set -a; export APP_ENV="${APP_ENV:-development}"
      [[ -f "env/${APP_ENV}.env" ]] && . "env/${APP_ENV}.env" 2>/dev/null
      set +a
      npx prisma migrate deploy 2>&1
    )"; then
      # prisma dice "X migrations applied" o "No pending migrations to apply".
      local summary
      summary="$(printf '%s' "$out" | rg -No 'No pending migrations.*|[0-9]+ migration[s]? .*applied|Applying migration.*' | tail -1)"
      green "OK ${summary:+— $summary}"
      ((ok++))
    else
      red "FALLÓ — $(printf '%s' "$out" | tail -1)"
      ((fail++))
    fi
  done
  printf '  %s%d ok · %d con error%s\n' "$C_DIM" "$ok" "$fail" "$C_RESET"
}

# ── 5. BOOT UNIFORME ──────────────────────────────────────────────────────────
# Reusa los boot scripts existentes (no reinventamos su lógica de secretos/
# health/orden) y agrega biometric (python). Después del boot, garantizamos que
# TODO PID quede registrado en .pids (incluido biometric y los que el boot
# escribió por su cuenta).
boot_all() {
  hdr "BOOT (servicios nativos)"
  export APP_ENV="${APP_ENV:-development}"

  blue "  → boot-passenger-stack.sh (identity/trip/dispatch/fleet/payment/rating/places/notification + bff)"
  bash "$SCRIPT_DIR/boot-passenger-stack.sh" start || yel "  boot-passenger devolvió error parcial (revisá arriba)"

  blue "  → boot-extra-services.sh (audit/media/panic/share/chat + driver-bff + admin-bff)"
  bash "$SCRIPT_DIR/boot-extra-services.sh" || yel "  boot-extra devolvió error parcial (revisá arriba)"

  boot_biometric
  boot_tracking
}

# tracking: Go, NO nest. Corre 'go run ./cmd/server' (puerto :3004 vía
# TRACKING_HTTP_ADDR de su env/development.env; default de config.go = :3004).
# Si NO hay 'go' en PATH NO falla la ignición: avisa y sigue.
boot_tracking() {
  local line; line="$(svc_line tracking)" || return 0
  local svc port dir kind health
  IFS='|' read -r svc port dir kind health <<<"$line"
  local svc_dir="$ROOT_DIR/$dir" logf="$LOGS_DIR/$svc.log" pidf="$PIDS_DIR/$svc.pid"

  if port_in_use "$port"; then
    blue "  · tracking ya corre en :$port (pid $(pid_on_port "$port")) — idempotente, no duplico"
    [[ -f "$pidf" ]] || pid_on_port "$port" > "$pidf"
    return 0
  fi
  if ! command -v go >/dev/null 2>&1; then
    yel "  · tracking: falta Go en PATH, no se levanta (instalá Go para correr el tracking-service)"
    return 0
  fi

  blue "  ▶ tracking (go run ./cmd/server :$port) → log: $logf"
  (
    cd "$svc_dir" || exit 1
    set -a
    export APP_ENV="${APP_ENV:-development}"
    . "env/${APP_ENV}.env" 2>/dev/null
    set +a
    exec go run ./cmd/server
  ) >"$logf" 2>&1 &
  echo $! > "$pidf"
  log "pid $(cat "$pidf")"
  # Reporte NO-mudo: tracking arranca su consumer MQTT ANTES del HTTP y hace os.Exit(1) si el broker
  # (:1883) no responde — el :3004 jamás bindea y el fallo quedaría silenciado por el redireccionamiento
  # del log. Le damos un respiro (go compila la 1ª vez) y, si el proceso ya murió, mostramos el motivo.
  sleep 2
  if ! kill -0 "$(cat "$pidf" 2>/dev/null)" 2>/dev/null && ! port_in_use "$port"; then
    red "  · tracking: el proceso terminó al arrancar — motivo (de $logf):"
    rg -No '"msg":"[^"]*"|"err":"[^"]*"' "$logf" 2>/dev/null | tail -3 | sed 's/^/      /' || tail -3 "$logf" | sed 's/^/      /'
  fi
}

# biometric: Python/uvicorn, NO nest. Arranca con su .venv si existe.
boot_biometric() {
  local line; line="$(svc_line biometric)" || return 0
  local svc port dir kind health
  IFS='|' read -r svc port dir kind health <<<"$line"
  local svc_dir="$ROOT_DIR/$dir" logf="$LOGS_DIR/$svc.log" pidf="$PIDS_DIR/$svc.pid"
  # APP_ENV puede no estar seteado al restartear SOLO biometric (no pasa por el boot de node que lo exporta).
  : "${APP_ENV:=development}"

  if port_in_use "$port"; then
    blue "  · biometric ya corre en :$port (pid $(pid_on_port "$port")) — idempotente, no duplico"
    # Aun así, si no hay pidfile, lo registramos desde el puerto (uniformidad del registro).
    [[ -f "$pidf" ]] || pid_on_port "$port" > "$pidf"
    return 0
  fi
  if [[ ! -x "$BIO_VENV/bin/uvicorn" ]]; then
    yel "  · biometric: FALTA $BIO_VENV/bin/uvicorn → corré el setup del servicio:"
    yel "      cd $dir && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
    return 0
  fi

  # Su env vive en env/development.env si existe; si no, env/preview.env (su único env hoy).
  local envf=""
  if [[ -f "$svc_dir/env/${APP_ENV}.env" ]]; then envf="$svc_dir/env/${APP_ENV}.env"
  elif [[ -f "$svc_dir/env/preview.env" ]]; then envf="$svc_dir/env/preview.env"; fi

  blue "  ▶ biometric (uvicorn :$port) → log: $logf"
  (
    cd "$svc_dir" || exit 1
    set -a
    [[ -n "$envf" ]] && . "$envf" 2>/dev/null
    set +a
    exec "$BIO_VENV/bin/uvicorn" app.main:app --host 0.0.0.0 --port "$port"
  ) >"$logf" 2>&1 &
  echo $! > "$pidf"
  log "pid $(cat "$pidf")"
  # Reporte NO-mudo: pydantic-settings explota al boot si un campo complejo (onnx_providers /
  # liveness_actions) no llega como JSON válido — y el `set -a; . env` redirigido tragaba el traceback.
  # Si el proceso ya murió (no bindeó :3015), mostramos la causa (SettingsError/Traceback) del log.
  sleep 2
  if ! kill -0 "$(cat "$pidf" 2>/dev/null)" 2>/dev/null && ! port_in_use "$port"; then
    red "  · biometric: el proceso terminó al arrancar — motivo (de $logf):"
    rg -N 'SettingsError|Error|Traceback|ValidationError' "$logf" 2>/dev/null | tail -3 | sed 's/^/      /' || tail -3 "$logf" | sed 's/^/      /'
  fi
}

# Tras el boot, garantizamos que CADA servicio arriba tenga su pidfile (el
# registro es lo que permite un `down` limpio mañana).
reconcile_pids() {
  local line svc port dir kind health pidf
  for line in "${SERVICES[@]}"; do
    IFS='|' read -r svc port dir kind health <<<"$line"
    pidf="$PIDS_DIR/$svc.pid"
    if port_in_use "$port" && [[ ! -f "$pidf" ]]; then
      pid_on_port "$port" > "$pidf"
    fi
  done
}

# wait_native_health: espera a que los servicios LENTOS no cubiertos por el wait de los boot scripts
# queden ESTABILIZADOS antes de pintar el tablero, así no salen ❌ falsos por timing. boot-passenger y
# boot-extra ya esperan a sus nest; los rezagados son biometric (carga modelos ONNX) y tracking (go
# compila la 1ª vez con `go run`). Loop con timeout ~60s; cortamos en cuanto cada uno da health vivo.
wait_native_health() {
  hdr "ESTABILIZACIÓN (servicios lentos: biometric/tracking)"
  local timeout=60 line svc port dir kind health i code
  for svc in biometric tracking; do
    line="$(svc_line "$svc")" || continue
    IFS='|' read -r svc port dir kind health <<<"$line"
    # Si ni siquiera abrió el puerto, no hay nada que esperar (su boot ya reportó el motivo).
    if ! port_in_use "$port" && [[ ! -f "$PIDS_DIR/$svc.pid" ]]; then
      yel "  · $svc no arrancó (sin puerto) — el tablero lo marcará down"
      continue
    fi
    printf '  [%s] esperando health en :%s ' "$svc" "$port"
    i=0
    while (( i < timeout )); do
      code="$(health_probe "http://localhost:$port" "$health")"
      case "$code" in
        2*|401|403) green "OK ($code)"; break ;;
      esac
      printf '.'; sleep 1; ((i++))
    done
    (( i >= timeout )) && yel "TIMEOUT (${timeout}s, último: ${code:-000}) — el tablero mostrará el estado real"
  done
}

# ── SUBCOMANDO: up ────────────────────────────────────────────────────────────
cmd_up() {
  printf '%s%s🔑 VEO · IGNICIÓN%s\n' "$C_BOLD" "$C_BLUE" "$C_RESET"
  infra_up_and_wait || { red "Infra no quedó healthy — ABORTO la ignición (los servicios la necesitan)."; exit 1; }
  gen_secrets
  build_all
  migrate_all
  boot_all
  reconcile_pids
  wait_native_health   # estabiliza los lentos (biometric/tracking) ANTES del tablero → sin ❌ falsos.
  cmd_status
}

# ── SUBCOMANDO: down ──────────────────────────────────────────────────────────
# Apagado LIMPIO en capas — resuelve el problema de hoy (procesos heterogéneos
# y huérfanos imposibles de matar limpio):
#   (a) por PIDs del registro (.pids/*.pid) — lo que arrancamos nosotros.
#   (b) por PUERTO conocido (lsof -ti | kill -9) — cubre los que no quedaron en
#       el registro (arrancados a mano, full-path, etc.).
#   (c) por PATRÓN (pkill -f) — cubre watchers `nest start` y full-path que ni
#       siquiera tienen el puerto abierto todavía.
#   biometric (uvicorn) cae por puerto y por patrón.
# Agresivo a propósito: es dev. NO toca docker salvo --infra.
cmd_down() {
  local kill_infra=0
  [[ "${1:-}" == "--infra" ]] && kill_infra=1
  hdr "APAGADO"

  # (a) por pidfiles del registro.
  blue "  [a] matando por pidfiles (.pids/)"
  local pidf pid name
  for pidf in "$PIDS_DIR"/*.pid; do
    [[ -e "$pidf" ]] || continue
    name="$(basename "$pidf" .pid)"
    pid="$(cat "$pidf" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null && log "[$name] TERM pid $pid"
    fi
    rm -f "$pidf"
  done
  sleep 1  # darle un respiro al TERM antes del KILL por puerto.

  # (b) por puerto conocido (KILL -9, cubre lo que sobrevivió o no estaba en registro).
  blue "  [b] matando por PUERTO (cubre huérfanos fuera del registro)"
  local line svc port rest p
  for line in "${SERVICES[@]}"; do
    IFS='|' read -r svc port rest <<<"$line"
    local pids; pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      printf '%s\n' "$pids" | xargs kill -9 2>/dev/null && log "[$svc] KILL -9 :$port (pids: $(printf '%s' "$pids" | tr '\n' ' '))"
    fi
  done

  # (c) por PATRÓN (cubre watchers y full-path que no abrieron puerto).
  blue "  [c] matando por PATRÓN (watchers / full-path / uvicorn)"
  pkill -f "veo-monorepo/services" 2>/dev/null && log "  pkill 'veo-monorepo/services'" || true
  pkill -f "nest start" 2>/dev/null && log "  pkill 'nest start'" || true
  pkill -f "uvicorn app.main:app" 2>/dev/null && log "  pkill 'uvicorn app.main:app' (biometric)" || true
  # tracking (Go): 'go run ./cmd/server' es un PADRE que compila y ejecuta un
  # binario HIJO en un tmpdir (p.ej. /var/folders/.../exe/server) que NO matchea
  # 'veo-monorepo/services'. Matamos AMBOS: el 'go run' padre y el binario hijo.
  pkill -f "go run ./cmd/server" 2>/dev/null && log "  pkill 'go run ./cmd/server' (tracking padre)" || true
  pkill -f "tracking-service" 2>/dev/null && log "  pkill 'tracking-service'" || true
  pkill -f "exe/server" 2>/dev/null && log "  pkill 'exe/server' (binario go run de tracking)" || true

  # Infra: SOLO con --infra.
  if (( kill_infra )); then
    blue "  [infra] docker compose down (--infra solicitado)"
    docker compose -f "$COMPOSE_FILE" down || red "  'docker compose down' falló"
  else
    log "  infra docker INTACTA (usá 'down --infra' para tumbarla también)"
  fi

  # Verificación honesta: re-scan de puertos.
  sleep 1
  hdr "VERIFICACIÓN POST-APAGADO"
  local survivors=0
  for line in "${SERVICES[@]}"; do
    IFS='|' read -r svc port rest <<<"$line"
    if port_in_use "$port"; then
      red "  ⚠️  [$svc] :$port SIGUE OCUPADO (pid $(pid_on_port "$port")) — sobrevivió al apagado"
      ((survivors++))
    fi
  done
  if (( survivors == 0 )); then
    green "  todos los puertos de servicios quedaron LIBRES ✅"
  else
    red "  $survivors puerto(s) sobrevivieron — investigá con: lsof -nP -i :<puerto>"
  fi
}

# ── SUBCOMANDO: status (EL TABLERO) ───────────────────────────────────────────
# dist ¿fresco? compara el mtime más reciente de dist/ vs el de src/. Si src es
# más nuevo que dist → "rebuild" (el código cambió pero no se recompiló).
dist_fresh() {
  local dir="$1"
  local dist="$ROOT_DIR/$dir/dist" src="$ROOT_DIR/$dir/src"
  [[ -d "$dist" ]] || { printf 'no-dist'; return; }
  [[ -d "$src" ]]  || { printf 'fresh'; return; }
  # mtime (epoch) del archivo más nuevo en cada árbol (find -newer no da el max directo).
  local dmax smax
  dmax="$(find "$dist" -type f -exec stat -f '%m' {} + 2>/dev/null | sort -rn | head -1)"
  smax="$(find "$src"  -type f -exec stat -f '%m' {} + 2>/dev/null | sort -rn | head -1)"
  [[ -z "$dmax" ]] && { printf 'no-dist'; return; }
  if [[ -n "$smax" && "$smax" -gt "$dmax" ]]; then printf 'stale'; else printf 'fresh'; fi
}

# ÚLTIMO ERROR — HONESTO ("el tablero del auto"): un error solo es alarma si es
# MÁS RECIENTE que la última request exitosa (2xx) del servicio. Si después del
# error hubo un 2xx, el servicio se RECUPERÓ → no gritamos falsa alarma.
#
# Contrato: imprime UN token con prefijo de estado que el caller colorea:
#   "ERR\t<resumen>"        → error ACTUAL  (caller lo pinta en ROJO)
#   "OK\trecuperado (...)"  → error viejo ya recuperado (caller lo pinta DIM)
#   ""  (vacío)             → nunca hubo error  (caller muestra "—")
#
# Decisión recuperado-vs-actual: comparamos el "time" (ISO-8601, offset Z
# uniforme → orden lexicográfico == orden cronológico, sin date -d de GNU que
# en darwin/BSD no existe) del último error contra el de la última 2xx.
last_error() {
  local svc="$1"
  local logf="$LOGS_DIR/$svc.log"   # decl. separada: bajo `set -u`, $svc debe
                                    # estar ya ligado antes de usarse en el RHS.
  [[ -f "$logf" ]] || { printf ''; return; }

  # Última línea con error: "level":"error" O un status 5xx (cualquiera cuenta).
  local errline
  errline="$(rg '"level":"error"|"status":5[0-9][0-9]' "$logf" 2>/dev/null | tail -1)"
  [[ -z "$errline" ]] && { printf ''; return; }   # sin errores nunca → limpio.

  # Última línea exitosa: status 2xx (incluye /health 200).
  local okline
  okline="$(rg '"status":2[0-9][0-9]' "$logf" 2>/dev/null | tail -1)"

  # Parseo + decisión en python3 (seguro en darwin; parsea JSON robusto y mide
  # "hace Xm" sin depender de date -d). Le pasamos ambas líneas por env.
  ERRLINE="$errline" OKLINE="$okline" python3 - <<'PY'
import os, json, re, sys
from datetime import datetime, timezone

def field_time(line):
    if not line:
        return None
    try:
        return json.loads(line).get("time")
    except Exception:
        m = re.search(r'"time":"([^"]+)"', line)
        return m.group(1) if m else None

def summarize(line):
    try:
        o = json.loads(line)
        code = o.get("code")
        msg = o.get("msg") or o.get("message") or ""
    except Exception:
        code = (re.search(r'"code":"([^"]*)"', line) or [None, None])[1] if '"code"' in line else None
        mm = re.search(r'"(?:msg|message)":"([^"]*)"', line)
        msg = mm.group(1) if mm else line[:60]
    # Saneamos: los stacks de Prisma traen \n reales → una sola línea, sin tabs.
    msg = re.sub(r'\s+', ' ', str(msg)).strip()
    out = (f"[{code}] " if code else "") + msg
    return out[:50] if out else line[:50]

def parse(ts):
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None

err_raw = os.environ.get("ERRLINE", "")
ok_raw  = os.environ.get("OKLINE", "")
err_ts = field_time(err_raw)
ok_ts  = field_time(ok_raw)

# Comparación: si la última 2xx es >= último error → recuperado.
recovered = bool(err_ts and ok_ts and ok_ts >= err_ts)

if recovered:
    edt = parse(err_ts)
    ago = ""
    if edt:
        mins = (datetime.now(timezone.utc) - edt).total_seconds() / 60.0
        ago = f" (últ err hace {int(mins)}m)" if mins >= 1 else " (últ err hace <1m)"
    sys.stdout.write(f"OK\trecuperado{ago}")
else:
    sys.stdout.write("ERR\t" + summarize(err_raw))
PY
}

cmd_status() {
  hdr "VEO · TABLERO"

  # ── Infra docker ──
  printf '%s  INFRA (docker)%s\n' "$C_DIM" "$C_RESET"
  local line label container port cstate
  for line in "${INFRA[@]}"; do
    IFS='|' read -r label container port <<<"$line"
    cstate="$(docker inspect -f '{{.State.Status}}{{if .State.Health}} ({{.State.Health.Status}}){{end}}' "$container" 2>/dev/null || echo 'no-docker')"
    local icon="${C_RED}❌${C_RESET}"
    [[ "$cstate" == running* ]] && icon="${C_GREEN}✅${C_RESET}"
    printf '    %b %-10s :%-5s %s%s%s\n' "$icon" "$label" "$port" "$C_DIM" "$cstate" "$C_RESET"
  done
  echo

  # ── Servicios ──
  # Encabezado de tabla. Los iconos (✅/⚠️/❌) viven en columnas PROPIAS de ancho
  # fijo (1 char + espacio) para que el ancho variable del emoji no descuadre las
  # columnas siguientes; las columnas de texto (HEALTH/DIST) van como tokens
  # planos con padding por bytes (sin emoji adentro) → alineación estable.
  printf '  %s  %-14s %-5s %-22s %-8s   %-9s %s%s\n' "$C_BOLD" "SERVICIO" "PORT" "HEALTH" "PID" "DIST" "ÚLTIMO ERROR" "$C_RESET"
  printf '  %s%s%s\n' "$C_DIM" "──────────────────────────────────────────────────────────────────────────────────" "$C_RESET"

  local svc dir kind health up=0 total=0
  for line in "${SERVICES[@]}"; do
    IFS='|' read -r svc port dir kind health <<<"$line"
    ((total++))
    local pidf="$PIDS_DIR/$svc.pid" pid="" hcode hicon hlabel hcolor dicon dlabel dcolor derr

    # PID: del puerto (verdad de runtime) o del registro como fallback.
    if port_in_use "$port"; then pid="$(pid_on_port "$port")"
    elif [[ -f "$pidf" ]]; then pid="$(cat "$pidf" 2>/dev/null)"; fi

    # HEALTH: icono (columna propia) + label plano (columna propia).
    # Probe: prueba el path DECLARADO del servicio ($health del mapa) PRIMERO y cae al multi-path
    # (/health → /api/v1/health → /health/live → /health/ready) como fallback. Así audit/share
    # (prefijo global → /api/v1/health) dan 200 sin loguear un 404 espurio en /health.
    if port_in_use "$port"; then
      hcode="$(health_probe "http://localhost:$port" "$health")"
      case "$hcode" in
        200|204) hicon="✅"; hcolor="$C_GREEN"; hlabel="200 OK"; ((up++)) ;;
        401|403) hicon="⚠️"; hcolor="$C_YEL";   hlabel="$hcode auth-gated"; ((up++)) ;;  # admin-bff: vivo, no down.
        000)     hicon="⚠️"; hcolor="$C_YEL";   hlabel="puerto up, sin health" ;;
        *)       hicon="❌"; hcolor="$C_RED";   hlabel="HTTP $hcode" ;;
      esac
    else
      hicon="❌"; hcolor="$C_RED"; hlabel="down"; pid="—"
    fi

    # DIST fresco: icono propio + label plano (palabras, sin emoji adentro).
    if [[ "$kind" == "node" ]]; then
      case "$(dist_fresh "$dir")" in
        fresh)   dicon="✅"; dcolor="$C_GREEN"; dlabel="ok" ;;
        stale)   dicon="⚠️"; dcolor="$C_YEL";   dlabel="rebuild" ;;
        no-dist) dicon="❌"; dcolor="$C_RED";   dlabel="no-dist" ;;
      esac
    else
      dicon=" "; dcolor="$C_DIM"; dlabel="—"  # python/go no tienen dist node.
    fi

    # ÚLTIMO ERROR honesto: last_error decide recuperado-vs-actual por timestamp.
    # Devuelve "ERR\t<msg>" (error ACTUAL → rojo), "OK\trecuperado…" (viejo → dim)
    # o vacío (nunca hubo error → "—").
    local dstate=""
    derr="$(last_error "$svc")"
    dstate="${derr%%$'\t'*}"; derr="${derr#*$'\t'}"
    case "$dstate" in
      ERR) derr="${C_RED}${derr}${C_RESET}" ;;
      OK)  derr="${C_DIM}${derr}${C_RESET}" ;;
      *)   derr="${C_DIM}—${C_RESET}" ;;
    esac

    # Layout: icono-health · svc · port · health-label · pid · icono-dist · dist-label · error.
    printf '  %b %-14s %-5s %b%-22s%b %-8s %b %b%-9s%b %b\n' \
      "$hicon" "$svc" "$port" "$hcolor" "$hlabel" "$C_RESET" "${pid:-—}" \
      "$dicon" "$dcolor" "$dlabel" "$C_RESET" "$derr"
  done

  printf '  %s%s%s\n' "$C_DIM" "──────────────────────────────────────────────────────────────────────────────────" "$C_RESET"
  local color="$C_GREEN"; (( up < total )) && color="$C_YEL"; (( up == 0 )) && color="$C_RED"
  printf '  %s%b%d/%d servicios arriba%b\n' "" "$color$C_BOLD" "$up" "$total" "$C_RESET"
  printf '  %slogs: %s/<svc>.log · pids: %s/<svc>.pid%s\n' "$C_DIM" "${LOGS_DIR#"$ROOT_DIR"/}" "${PIDS_DIR#"$ROOT_DIR"/}" "$C_RESET"
}

# ── SUBCOMANDO: logs ──────────────────────────────────────────────────────────
cmd_logs() {
  local svc="${1:-}" follow="${2:-}"
  if [[ -z "$svc" ]]; then red "uso: veo.sh logs <svc> [-f]"; exit 1; fi
  local logf="$LOGS_DIR/$svc.log"
  if [[ ! -f "$logf" ]]; then
    red "no existe $logf"
    yel "servicios con log: $(ls "$LOGS_DIR" 2>/dev/null | sed 's/\.log$//' | tr '\n' ' ')"
    exit 1
  fi
  if [[ "$follow" == "-f" ]]; then tail -f "$logf"; else tail -n 80 "$logf"; fi
}

# ── SUBCOMANDO: monitor (EL ESCÁNER EN VIVO) ──────────────────────────────────
# El "escáner en vivo" del tablero: sigue los logs de TODOS los servicios desde
# AHORA (no historia) y muestra SOLO los errores en el momento que pasan, en UNA
# línea legible y coloreada (no el JSON crudo). Hermano de `status`: mismo parseo
# con python3 (robusto en darwin, sin date -d de GNU), mismos colores/iconos.
#
# Qué cuenta como error: "level":"error"/"fatal" o status 4xx/5xx.
# Ruido benigno que EXCLUIMOS: el 401 auth-gated del admin-bff (esperado) y las
# requests a /health (chequeos de salud, no errores reales).
#
# Robustez: si una línea no parsea como JSON, NO crasheamos — la degradamos a su
# forma cruda truncada. El `tail -n0 -F` arranca en el fin de cada log (solo
# nuevas líneas) y muere con el script (trap → kill del tail → exit limpio).
cmd_monitor() {
  # Nº de servicios con log presente (los que realmente vamos a vigilar).
  local nlogs; nlogs="$(ls "$LOGS_DIR"/*.log 2>/dev/null | grep -v '/_build.log$' | wc -l | tr -d ' ')"

  printf '\n%s== VEO · ESCÁNER EN VIVO ==%s\n' "$C_BOLD$C_BLUE" "$C_RESET"
  printf '  %svigilando %s servicios · solo errores en vivo · Ctrl-C para salir%s\n\n' \
    "$C_DIM" "${nlogs:-?}" "$C_RESET"

  if [[ "${nlogs:-0}" == "0" ]]; then
    red "  no hay logs en $LOGS_DIR — ¿levantaste el stack? (veo.sh up)"
    exit 1
  fi

  # Arrancamos el seguidor: tail -n0 -F (BSD/darwin: sigue desde el final de cada
  # archivo, re-abre en rotación) PIPEADO a un filtro python3 line-buffered. El
  # tail corre en background con su PID conocido para matarlo limpio en el trap →
  # no deja procesos colgados. Los colores van por env (modo no-tty → vacíos → sin
  # ANSI). Usamos un FIFO efímero para que el trap pueda matar el tail por PID
  # exacto (no por patrón), evitando el problema clásico del pipe donde el PID del
  # tail se pierde dentro del subshell del pipeline.
  local fifo filt
  fifo="$PIDS_DIR/.monitor.fifo"
  filt="$PIDS_DIR/.monitor-filter.py"
  rm -f "$fifo" 2>/dev/null
  mkfifo "$fifo" 2>/dev/null || { red "  no pude crear el FIFO $fifo"; exit 1; }

  # Volcamos el filtro python a un archivo (NO podemos usar a la vez heredoc para
  # el SCRIPT y redirección del FIFO para los DATOS en el mismo `python3 -`: el
  # heredoc se llevaría el stdin). Con el filtro en archivo, stdin queda libre
  # para el FIFO de datos.
  cat > "$filt" <<'PY'
import os, sys, json, re, signal
from datetime import datetime

# Salida limpia ante Ctrl-C / cierre del FIFO: nunca un traceback de python.
signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
try:
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
except Exception:
    pass

R   = os.environ.get("C_RESET", "")
RED = os.environ.get("C_RED", "")
YEL = os.environ.get("C_YEL", "")
DIM = os.environ.get("C_DIM", "")

def short_time(ts):
    # ISO-8601 → HH:MM:SS local. Sin date -d de GNU: parseamos con datetime.
    if not ts:
        return "--:--:--"
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        return dt.astimezone().strftime("%H:%M:%S")
    except Exception:
        # Fallback: si trae "T", agarramos los 8 chars de hora.
        m = re.search(r"T(\d{2}:\d{2}:\d{2})", str(ts))
        return m.group(1) if m else "--:--:--"

def collapse(s, n=90):
    s = re.sub(r"\s+", " ", str(s)).strip()
    return (s[: n - 1] + "…") if len(s) > n else s

for raw in sys.stdin:
    line = raw.rstrip("\n")
    # tail -F intercala separadores "==> file <==" al seguir múltiples archivos:
    # los ignoramos en silencio.
    if not line.strip() or line.startswith("==>"):
        continue

    try:
        o = json.loads(line)
        # json.loads acepta strings/números/listas sueltos; SOLO un objeto JSON
        # (dict) tiene los campos pino. Si no es dict → tratamos como no-parseado
        # (cae a la degradación cruda; nunca .get() sobre un str → AttributeError).
        parsed = isinstance(o, dict)
    except Exception:
        parsed = False
    if not parsed:
        o = {}

    if parsed:
        level = str(o.get("level", "")).lower()
        status = o.get("status")
        try:
            status_i = int(status) if status is not None else None
        except Exception:
            status_i = None
        service = str(o.get("service", "?"))
        route = o.get("route") or o.get("url") or ""

        is_err_level = level in ("error", "fatal")
        is_err_status = status_i is not None and 400 <= status_i <= 599

        # No es error → no nos interesa (el escáner muestra SOLO errores).
        if not (is_err_level or is_err_status):
            continue

        # Ruido benigno EXCLUIDO:
        #   1) el 401 auth-gated del admin-bff (esperado, no es falla).
        #   2) cualquier request a /health (chequeo de salud).
        if status_i == 401 and service == "admin-bff":
            continue
        if str(route).startswith("/health"):
            continue

        # ── Formato legible ──
        t = short_time(o.get("time"))
        svc = service[:-8] if service.endswith("-service") else service  # saca "-service".
        trace = str(o.get("traceId", ""))[:8]

        # Color/etiqueta: 5xx o error/fatal → rojo; 4xx o warn → amarillo.
        if is_err_status and 500 <= status_i <= 599:
            col, lvl = RED, "ERROR"
        elif is_err_level:
            col, lvl = (RED, "ERROR") if level in ("error", "fatal") else (YEL, "WARN")
        else:  # 4xx
            col, lvl = YEL, "WARN"

        parts = [f"{DIM}{t}{R}", f"{col}{svc:<12}{R}", f"{col}{lvl:<5}{R}"]
        if status_i is not None:
            parts.append(f"status={status_i}")
        method = o.get("method")
        if method and route:
            parts.append(f"{method} {route}")
        if trace:
            parts.append(f"{DIM}trace={trace}{R}")

        # Resumen del mensaje: msg, o err.message si es objeto, o code.
        err = o.get("err")
        msg = o.get("msg") or o.get("message") or ""
        if isinstance(err, dict):
            emsg = err.get("message") or ""
            if emsg:
                msg = f"{msg} {emsg}".strip() if msg else emsg
        elif isinstance(err, str):
            msg = f"{msg} {err}".strip() if msg else err
        code = o.get("code")
        summary = collapse((f"[{code}] " if code else "") + str(msg)) if (msg or code) else ""
        if summary:
            parts.append(summary)

        sys.stdout.write("  " + "  ".join(parts) + "\n")
        sys.stdout.flush()
    else:
        # Degradación segura: una línea que NO parseó. Solo nos interesa la que
        # ITENTÓ ser pino JSON (arranca con "{") pero quedó truncada/corrupta — esa
        # SÍ la mostramos cruda en vez de crashear. Exigimos que ARRANQUE con "{" Y
        # traiga los campos tempranos de pino ("level"/"time") → así solo cae acá
        # una línea pino REAL que quedó truncada/corrupta, no fragmentos ("{" suelto
        # de un JSON pretty-printed, continuaciones de stack, Nest multilínea ANSI).
        # Default seguro: nunca un stacktrace de python, nunca un firehose.
        ls = line.lstrip()
        if ls.startswith("{") and ('"level"' in ls or '"time"' in ls):
            sys.stdout.write(f"  {DIM}(raw){R} {collapse(line, 110)}\n")
            sys.stdout.flush()
PY

  # Lista de logs a seguir: TODOS los *.log MENOS _build.log (transcript de turbo,
  # no pino JSON → solo generaría ruido crudo). Array para no romper con espacios.
  local logfiles=() f
  for f in "$LOGS_DIR"/*.log; do
    [[ -e "$f" ]] || continue
    [[ "$(basename "$f")" == "_build.log" ]] && continue
    logfiles+=("$f")
  done

  # Seguidor: tail -n0 -F (BSD/darwin sigue desde el final y re-abre en rotación)
  # vuelca al FIFO; el filtro python lee del FIFO. Ambos en background con PID
  # conocido para un cleanup por PID exacto (sin pkill por patrón).
  tail -n0 -F "${logfiles[@]}" 2>/dev/null > "$fifo" &
  local tail_pid=$!
  C_RESET="$C_RESET" C_RED="$C_RED" C_YEL="$C_YEL" C_DIM="$C_DIM" C_GREEN="$C_GREEN" \
    python3 -u "$filt" < "$fifo" &
  local py_pid=$!

  # Cleanup IDEMPOTENTE: matamos tail + python por PID exacto, borramos FIFO y el
  # filtro temporal. Lo enganchamos a INT/TERM (Ctrl-C / kill) y TAMBIÉN a EXIT,
  # así pase lo que pase (señal, EOF, error) NO quedan procesos colgados ni temp
  # files. El guard `_cleaned` evita el doble mensaje cuando EXIT corre tras INT.
  # NB: bajo `set -u`, el trap puede dispararse en un punto donde `_cleaned` aún no
  # esté ligado → usamos `${_cleaned:-0}` para nunca explotar con "unbound variable".
  _cleaned=0
  cleanup() {
    [[ "${_cleaned:-0}" == "1" ]] && return 0
    _cleaned=1
    kill "${tail_pid:-0}" "${py_pid:-0}" 2>/dev/null
    rm -f "$fifo" "$filt" 2>/dev/null
    printf '\n%s  escáner detenido.%s\n' "$C_DIM" "$C_RESET"
  }
  trap 'cleanup; exit 0' INT TERM
  trap cleanup EXIT

  # Esperamos al filtro. Si el tail muere (raro), el filtro recibe EOF del FIFO y
  # termina → wait retorna → el trap EXIT limpia igual.
  wait "$py_pid"
}

# ── SUBCOMANDO: restart <svc> ─────────────────────────────────────────────────
# down de ESE servicio (pidfile + puerto) → build de ESE servicio → boot.
cmd_restart() {
  local svc="${1:-}"
  if [[ -z "$svc" ]]; then red "uso: veo.sh restart <svc>"; exit 1; fi
  local line; line="$(svc_line "$svc")" || { red "servicio desconocido: $svc"; exit 1; }
  local s port dir kind health
  IFS='|' read -r s port dir kind health <<<"$line"

  hdr "RESTART · $svc"
  # 1) down de ESE servicio.
  local pidf="$PIDS_DIR/$svc.pid"
  if [[ -f "$pidf" ]]; then
    local pid; pid="$(cat "$pidf" 2>/dev/null)"
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null && log "TERM pid $pid"
    rm -f "$pidf"
  fi
  local pids; pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)"
  [[ -n "$pids" ]] && { printf '%s\n' "$pids" | xargs kill -9 2>/dev/null; log "KILL -9 :$port"; }
  sleep 1

  # 2) build de ESE servicio (solo node; python/go no buildean acá).
  if [[ "$kind" == "node" ]]; then
    blue "  build $svc"
    # @veo/* primero por si cambió un package del que depende; luego el servicio.
    pnpm -r --filter "./packages/*" build >/dev/null 2>&1 || yel "  build de packages tuvo errores (sigo)"
    if ! pnpm exec turbo run build --filter="./$dir" 2>&1 | tail -5; then
      yel "  build de $svc falló — intento bootear el dist viejo igual"
    fi
  fi

  # 3) boot de ESE servicio.
  blue "  boot $svc"
  case "$kind" in
    node)
      # Reusamos boot-passenger para los suyos; boot-extra para los demás. Ambos
      # son idempotentes por puerto, así arrancan SOLO lo que falta (este).
      case "$svc" in
        identity|trip|dispatch|payment|rating|fleet|places|notification|bff)
          bash "$SCRIPT_DIR/boot-passenger-stack.sh" start ;;
        audit|media|panic|share|chat|driver-bff|admin-bff)
          bash "$SCRIPT_DIR/boot-extra-services.sh" ;;
      esac ;;
    python) boot_biometric ;;
    go) boot_tracking ;;
  esac
  reconcile_pids
  echo
  cmd_status
}

# ── SUBCOMANDO: migrate ───────────────────────────────────────────────────────
cmd_migrate() { migrate_all; }

# ── Dispatcher ────────────────────────────────────────────────────────────────
case "${1:-}" in
  up)      cmd_up ;;
  down)    shift; cmd_down "${1:-}" ;;
  status)  cmd_status ;;
  monitor) cmd_monitor ;;
  restart) shift; cmd_restart "${1:-}" ;;
  logs)    shift; cmd_logs "${1:-}" "${2:-}" ;;
  migrate) cmd_migrate ;;
  *)
    cat <<EOF
${C_BOLD}veo.sh${C_RESET} · ignición + apagado + tablero del stack de dev VEO

  ${C_BOLD}up${C_RESET}                 Ignición completa (infra → secrets → build → migrate → boot → tablero)
  ${C_BOLD}down${C_RESET} [--infra]     Apagado limpio en capas (pidfiles → puertos → patrón). --infra baja docker
  ${C_BOLD}status${C_RESET}             El tablero (health/pid/dist/último error por servicio + infra)
  ${C_BOLD}monitor${C_RESET}            El escáner EN VIVO: sigue todos los logs y muestra solo errores al pasar
  ${C_BOLD}restart${C_RESET} <svc>      down + build + boot de ESE servicio
  ${C_BOLD}logs${C_RESET} <svc> [-f]    tail (o tail -f) de dev-stack/logs/<svc>.log
  ${C_BOLD}migrate${C_RESET}            prisma migrate deploy de todos los servicios (idempotente)

  servicios: $(printf '%s ' "${SERVICES[@]%%|*}")
EOF
    exit 1 ;;
esac
