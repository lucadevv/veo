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
#   dev [--no-seed] [--seed-trips[=N]]
#                      Como `up` pero los servicios arrancan en WATCH (nest start
#                      --watch / uvicorn --reload): editás el SRC de un servicio y
#                      recompila + reinicia SOLO. Infra en docker; admin-web en WATCH (next dev/HMR);
#                      apps RN aparte. Libs @veo/* y tracking(Go) → restart manual.
#                      AUTO-SIEMBRA barato (identity/driver/media) tras las migraciones —
#                      --no-seed lo saltea. --seed-trips[=N] (default 2) siembra viajes AL FINAL
#                      (opt-in: necesita el stack vivo).
#   down [--infra]     Apagado LIMPIO y robusto en capas (pidfiles → puertos →
#                      pkill por patrón). Con --infra además baja los contenedores.
#   status             El TABLERO: una fila por servicio (puerto, health, pid,
#                      último error de log, dist ¿fresco?) + infra docker.
#   monitor            El ESCÁNER EN VIVO: sigue los logs de los 18 servicios en
#                      tiempo real y muestra SOLO los errores en el momento que pasan.
#   restart <svc>      down de ESE servicio (pidfile/puerto) + build + boot.
#   logs <svc> [-f]    tail (o tail -f con -f) de dev-stack/logs/<svc>.log.
#   migrate            Solo el paso de migraciones (prisma migrate deploy) — seguro/idempotente.
#   otp [-f]           Escáner de OTP de dev: muestra el código de cualquier OTP (driver/pasajero,
#                      SMS sandbox + email) leyéndolo de notification.notifications. -f = en vivo.
#                      El admin usa TOTP (Google Authenticator), no pasa por acá.
#   trazar <paquete>   Gate determinista (00 §8) SCOPEADO a UN paquete (~2s). El root del monorepo
#                      compila ~32 sub-proyectos y cuelga >2min → siempre scopeá al paquete tocado.
#   login [--json]     Auto-login del admin de dev: calcula el TOTP vivo, hace POST /auth/login y
#                      devuelve las cookies veo_at/veo_rt pegables (chrome-devtools/curl). --json = para pipes.
#   seed [target]      Orquestador de seeds DEV idempotentes: identity (admin+6 roles+TOTP fijo) · driver
#                      (conductor elegible+vehículo+docs) · media (solicitudes de acceso a video). Sin arg =
#                      los 3 (solo piden postgres). 'seed trips' es orquestación aparte (requiere stack vivo).
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
PG_CONT="veo-postgres"   # contenedor de infra postgres (fijo en dev) — lo consume `veo.sh otp`.

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
#   kind         → node | python | go | web  (define cómo se buildea/arranca).
#                  web = Next.js (admin-web): dev→`next dev` (HMR), up→`next start` (buildeado).
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
  "booking|3016|services/booking-service|node|/health"
  "biometric|3015|services/biometric-service|python|/health"
  "tracking|3004|services/tracking-service|go|/health"
  "bff|4001|services/bff/public-bff|node|/health/live"
  "driver-bff|4002|services/bff/driver-bff|node|/health"
  "admin-bff|4003|services/bff/admin-bff|node|/health"
  # admin-web (Next.js) — única superficie WEB que veo.sh ahora gestiona como un servicio más.
  # Puerto 5001 (el 5000 lo ocupa ControlCenter de macOS). health = "/" → la home redirige al login
  # (307), que el probe/tablero tratan como VIVO (igual criterio que el 401 auth-gated del admin-bff).
  "admin-web|5001|apps/admin-web|web|/"
  # otp-viewer — visor web de OTPs de dev (http://localhost:5190). Node http NATIVO, cero deps,
  # NO nest: kind=mjs (sin build, sin prisma, sin dist). health = "/" (el HTML del visor da 200).
  "otp-viewer|5190|dev-stack/otp-viewer|mjs|/"
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
      2*|3[0-9][0-9]|401|403) printf '%s' "$code"; return 0 ;;  # vivo: 2xx, redirect 3xx (admin-web "/" → /login), o auth-gated → cortamos.
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

  # Aprovisiona los buckets de MinIO (avatars/video/documents) vía el sidecar one-shot `minio-provision`
  # (idempotente, espera minio healthy por su depends_on). NO va en INFRA_SERVICES_COMPOSE porque es one-shot
  # sin healthcheck (rompería el wait). SIN esto los buckets no existen y el upload de docs (DNI/licencia) da
  # 404 NoSuchBucket. Se corre en cada boot; --ignore-existing lo hace idempotente.
  blue "  [minio] aprovisionando buckets (avatars/video/documents)…"
  docker compose -f "$COMPOSE_FILE" up -d minio-provision >/dev/null 2>&1 || \
    red "  [minio] minio-provision FALLÓ al disparar — los buckets podrían no existir (upload de docs daría 404)"

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
  ensure_web_assets
}

# ── 1c. MAPS (soberano: tiles + ruteo + geocoding) — perfil "maps", best-effort ────────────────
# tileserver (tiles MapLibre) + osrm (ruteo) + nominatim (geocoding/reverse), TODO desde datos OSM
# propios (FOUNDATION §0.7, jamás Google) preparados por dev-stack/maps/prepare.sh. Se levanta SOLO si
# los datos ya existen — un clone fresco sin prep NO rompe el boot (se salta con aviso). Nominatim IMPORTA
# en su primer arranque (osm2pgsql + indexado, varios min) → NO se espera healthy: queda importando en
# background (no bloquea el boot). Mientras, el reverse-geocode del admin cae a modo 'local' (ya funciona).
MAPS_DIR="$SCRIPT_DIR/maps"
maps_up() {
  hdr "MAPS (soberano · tiles + ruteo + geocoding)"
  local mbtiles="$MAPS_DIR/tiles/region.mbtiles"
  local osrm="$MAPS_DIR/osrm/region.osrm.mldgr"
  local pbf="$MAPS_DIR/nominatim/data/region.osm.pbf"
  if [[ ! -f "$mbtiles" || ! -f "$osrm" || ! -f "$pbf" ]]; then
    yel "  perfil maps SIN datos preparados → se salta (no crítico: el geocoder del admin cae a modo 'local')."
    yel "  para activarlo: corré 'dev-stack/maps/prepare.sh' (baja el extracto OSM + genera tiles/ruteo/geocoding) y re-corré 'veo.sh dev'."
    return 0
  fi
  blue "  levantando maps (tileserver + osrm + nominatim)…"
  if ! docker compose -f "$COMPOSE_FILE" --profile maps up -d tileserver osrm nominatim; then
    red "  maps FALLÓ al disparar (no crítico: el reverse-geocode del admin usa modo 'local'). Revisá docker."
    return 0
  fi
  green "  maps disparado — tileserver :8082 · osrm :5005 · nominatim :8081."
  yel "  Nominatim IMPORTA el extracto en su 1er arranque (background). Cuando termine, para geocoding a nivel"
  yel "  calle: poné VEO_MAPS_MODE=osrm en services/bff/admin-bff/env/development.env y reiniciá el admin-bff."
}

# ── 1b. WEB ASSETS (login-hero.mp4) ───────────────────────────────────────────
# El video de fondo del login es un BINARIO pesado (~123MB) → gitignored (regla del proyecto: binarios NO en
# git, van a MinIO self-hosted referenciados). Vive en el bucket PÚBLICO veo-web-assets-dev (branding decorativo,
# sin PII → sin cifrar). Sync BIDIRECCIONAL idempotente para que `veo.sh dev` SIEMPRE lo levante, hasta en un
# worktree fresco (que no trae gitignored):
#   · local presente + MinIO vacío → lo SUBE (el 1er checkout que tenga el asset siembra MinIO para todos).
#   · local ausente (worktree)      → lo BAJA de MinIO (bucket público → curl sin firma) a public/.
#   · en ningún lado                → avisa cómo proveerlo; el login cae al fondo negro (degradación honesta, no rompe).
ensure_web_assets() {
  local dest="$ROOT_DIR/apps/admin-web/public/login-hero.mp4"
  local url="http://localhost:9002/veo-web-assets-dev/login-hero.mp4"
  local obj="local/veo-web-assets-dev/login-hero.mp4"
  if [[ -f "$dest" ]]; then
    # Sembrar MinIO SOLO si el objeto aún no existe (idempotente; no re-sube en cada boot).
    if ! curl -sfI "$url" >/dev/null 2>&1; then
      blue "  [web-assets] sembrando login-hero.mp4 en MinIO (primer checkout con el asset)…"
      docker exec veo-minio mc alias set local http://localhost:9000 veo_dev veo_dev_secret >/dev/null 2>&1
      if docker cp "$dest" veo-minio:/tmp/login-hero.mp4 >/dev/null 2>&1 \
        && docker exec veo-minio mc cp /tmp/login-hero.mp4 "$obj" >/dev/null 2>&1; then
        docker exec veo-minio rm -f /tmp/login-hero.mp4 >/dev/null 2>&1
        green "  [web-assets] login-hero.mp4 sembrado en MinIO"
      else
        yel "  [web-assets] no pude sembrar el video en MinIO (sigo; el asset local igual sirve el login)"
      fi
    fi
  else
    # Worktree/checkout sin el asset: bajarlo de MinIO (bucket público).
    if curl -sfI "$url" >/dev/null 2>&1; then
      blue "  [web-assets] bajando login-hero.mp4 de MinIO → public/…"
      if curl -sf "$url" -o "$dest" 2>/dev/null; then
        green "  [web-assets] login-hero.mp4 provisto ($(du -h "$dest" 2>/dev/null | cut -f1))"
      else
        rm -f "$dest" 2>/dev/null
        yel "  [web-assets] falló la descarga del video (sigo; el login usa fondo negro)"
      fi
    else
      yel "  [web-assets] login-hero.mp4 no está en public/ ni en MinIO → el login usa fondo negro. Para tenerlo: dejá el .mp4 en apps/admin-web/public/ y re-corré 'veo.sh dev' (se siembra en MinIO solo)."
    fi
  fi
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
      summary="$(printf '%s' "$out" | grep -Eo 'No pending migrations.*|[0-9]+ migration[s]? .*applied|Applying migration.*' | tail -1)"
      green "OK ${summary:+— $summary}"
      ((ok++))
    else
      red "FALLÓ — $(printf '%s' "$out" | tail -1)"
      ((fail++))
    fi
  done
  printf '  %s%d ok · %d con error%s\n' "$C_DIM" "$ok" "$fail" "$C_RESET"
}

# ── 4-bis. DRIFT de migraciones (verificación read-only, RÁPIDA) ──────────────
# La RED para el caso que mordió a payment: se crean migraciones nuevas y se hace
# 'restart <svc>' individual (que NO migra) → la DB queda ATRÁS sin que nadie
# avise. El boot full (up/dev) sí aplica via migrate_all; esto DETECTA el drift
# cuando NO hubo boot full. Compara los dirs de prisma/migrations contra las filas
# YA aplicadas en <schema>._prisma_migrations (consulta directa al contenedor
# postgres — NO usa 'npx prisma migrate status', que tarda ~2s/servicio y haría
# lento el tablero). Emite "svc|pendientes" por servicio atrasado (stdout vacío =
# todo al día). Si la DB/tabla no se puede leer, NO inventa drift (degradación
# honesta): omite ese servicio en silencio.
migrate_drift() {
  local pgc="" l
  for l in "${INFRA[@]}"; do [[ "$l" == postgres\|* ]] && pgc="$(printf '%s' "$l" | cut -d'|' -f2)"; done
  [[ -n "$pgc" ]] || pgc="veo-postgres"
  local line svc port dir kind health ndir schema napp
  for line in "${SERVICES[@]}"; do
    IFS='|' read -r svc port dir kind health <<<"$line"
    [[ "$kind" == "node" && -d "$ROOT_DIR/$dir/prisma/migrations" ]] || continue
    ndir="$(find "$ROOT_DIR/$dir/prisma/migrations" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
    # schema del DATABASE_URL. OJO: con grep/sed POSIX, NO rg — rg vive en homebrew y NO está en el
    # PATH del bash del shebang (#!/usr/bin/env bash, no-login) → adentro de veo.sh 'rg' = command-not-found
    # silencioso. (El migrate_all de arriba arrastra el mismo latente, pero ahí su rg es solo cosmético.)
    schema="$(grep -m1 '^DATABASE_URL=' "$ROOT_DIR/$dir/env/${APP_ENV:-development}.env" 2>/dev/null | sed -n 's/.*[?&]schema=\([A-Za-z0-9_]*\).*/\1/p')"
    [[ -n "$schema" ]] || continue
    napp="$(docker exec "$pgc" psql -U veo -d veo -At -c \
      "SELECT count(*) FROM \"$schema\"._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;" 2>/dev/null)"
    [[ "$napp" =~ ^[0-9]+$ ]] || continue
    (( ndir > napp )) && printf '%s|%d\n' "$svc" "$(( ndir - napp ))"
  done
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

  blue "  → boot-extra-services.sh (audit/media/panic/share/chat/booking + driver-bff + admin-bff)"
  bash "$SCRIPT_DIR/boot-extra-services.sh" || yel "  boot-extra devolvió error parcial (revisá arriba)"

  boot_biometric
  boot_tracking
  boot_admin_web   # web (Next.js): dev→next dev (HMR) · up→next start (buildeado). Distingue por VEO_WATCH.
  boot_otp_viewer  # visor de OTPs de dev (:5190) — los sandbox senders le POSTean; sin él los OTP no se ven.
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

  if [[ "${VEO_WATCH:-0}" == "1" ]]; then
    blue "  ▶ biometric (uvicorn --reload :$port) → log: $logf"
  else
    blue "  ▶ biometric (uvicorn :$port) → log: $logf"
  fi
  (
    cd "$svc_dir" || exit 1
    set -a
    [[ -n "$envf" ]] && . "$envf" 2>/dev/null
    set +a
    # WATCH: uvicorn --reload reinicia ante cada cambio de los .py del servicio.
    if [[ "${VEO_WATCH:-0}" == "1" ]]; then
      exec "$BIO_VENV/bin/uvicorn" app.main:app --host 0.0.0.0 --port "$port" --reload
    else
      exec "$BIO_VENV/bin/uvicorn" app.main:app --host 0.0.0.0 --port "$port"
    fi
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

# otp-viewer: visor web de OTPs de dev (:5190). Node http NATIVO (cero deps, ni build ni install),
# NO nest. Misma PLOMERÍA que biometric/tracking (pid → .pids, log → logs, idempotente por puerto,
# reporte-no-mudo si muere al boot). dev (VEO_WATCH=1) → `node --watch` (reinicia si tocás server.mjs);
# up → node plano. El puerto sale del MAPA (SERVICES) vía OTP_VIEWER_PORT — única fuente, no el default
# hardcodeado del server.mjs.
boot_otp_viewer() {
  local line; line="$(svc_line otp-viewer)" || return 0
  local svc port dir kind health
  IFS='|' read -r svc port dir kind health <<<"$line"
  local svc_dir="$ROOT_DIR/$dir" logf="$LOGS_DIR/$svc.log" pidf="$PIDS_DIR/$svc.pid"

  if port_in_use "$port"; then
    blue "  · otp-viewer ya corre en :$port (pid $(pid_on_port "$port")) — idempotente, no duplico"
    [[ -f "$pidf" ]] || pid_on_port "$port" > "$pidf"
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    yel "  · otp-viewer: falta node en PATH — no se levanta (los OTP de dev no se verán en el visor)"
    return 0
  fi

  if [[ "${VEO_WATCH:-0}" == "1" ]]; then
    blue "  ▶ otp-viewer (node --watch server.mjs :$port) → log: $logf"
  else
    blue "  ▶ otp-viewer (node server.mjs :$port) → log: $logf"
  fi
  (
    cd "$svc_dir" || exit 1
    export OTP_VIEWER_PORT="$port"
    if [[ "${VEO_WATCH:-0}" == "1" ]]; then
      exec node --watch server.mjs
    else
      exec node server.mjs
    fi
  ) >"$logf" 2>&1 &
  echo $! > "$pidf"
  log "pid $(cat "$pidf")"
  # Reporte NO-mudo (espejo de biometric/tracking): si murió al arrancar (típico: :5190 tomado
  # por algo ajeno — la regla de puertos manda REPORTAR, no saltar de puerto), mostramos el motivo.
  sleep 1
  if ! kill -0 "$(cat "$pidf" 2>/dev/null)" 2>/dev/null && ! port_in_use "$port"; then
    red "  · otp-viewer: el proceso terminó al arrancar — motivo (de $logf):"
    tail -3 "$logf" | sed 's/^/      /'
  fi
}

# admin-web: Next.js, NO nest. Misma PLOMERÍA que biometric/tracking (pid → .pids, log → logs,
# idempotente por puerto, reporte-no-mudo si muere al boot); SOLO cambia el COMANDO de arranque.
#   dev (VEO_WATCH=1): `next dev` → HMR NATIVO de Next (observa su propio src). NO usa el VEO_WATCH de
#                      nest — es solo el flag con el que distinguimos watch-vs-buildeado, igual que biometric.
#   up  (buildeado):   `next start` sobre la build de producción. `next start` SIN build previo aborta
#                      ("Could not find a production build") ⇒ si falta .next/BUILD_ID, buildeamos UNA vez
#                      (coste amortizado: los `up` siguientes reusan la build). Decisión up=start / dev=dev:
#                      respeta la semántica del script (up=buildeado, como `node dist/main`) sin pagar un
#                      `next build` (lento) en CADA ignición.
# ENVFILE: lo lee next.config (process.env.ENVFILE ?? 'env/development.env'). Le pasamos el MISMO valor
# que el package.json (dev→development.env, start→production.env) — lo respetamos, no lo pisamos.
# El puerto sale del MAPA (SERVICES), única fuente — no del -p hardcodeado del package.json.
boot_admin_web() {
  local line; line="$(svc_line admin-web)" || return 0
  local svc port dir kind health
  IFS='|' read -r svc port dir kind health <<<"$line"
  local svc_dir="$ROOT_DIR/$dir" logf="$LOGS_DIR/$svc.log" pidf="$PIDS_DIR/$svc.pid"

  if port_in_use "$port"; then
    blue "  · admin-web ya corre en :$port (pid $(pid_on_port "$port")) — idempotente, no duplico"
    [[ -f "$pidf" ]] || pid_on_port "$port" > "$pidf"
    return 0
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    yel "  · admin-web: falta pnpm en PATH — no se levanta (instalá pnpm / corepack enable)"
    return 0
  fi

  if [[ "${VEO_WATCH:-0}" == "1" ]]; then
    # WATCH (dev): next dev → HMR nativo. ENVFILE=env/development.env (== package.json `dev`).
    blue "  ▶ admin-web (next dev :$port · HMR nativo) → log: $logf"
    (
      cd "$svc_dir" || exit 1
      exec env ENVFILE="env/development.env" pnpm exec next dev -p "$port"
    ) >"$logf" 2>&1 &
    echo $! > "$pidf"
  else
    # UP (buildeado): si no hay build de producción, la construimos UNA vez (next start la exige).
    if [[ ! -f "$svc_dir/.next/BUILD_ID" ]]; then
      blue "  · admin-web: sin build de producción (.next/BUILD_ID) → 'next build' (1ª vez, puede tardar) …"
      (
        cd "$svc_dir" || exit 1
        env ENVFILE="env/production.env" pnpm exec next build
      ) >"$logf" 2>&1 || yel "  · admin-web: 'next build' devolvió error (revisá $logf) — intento 'next start' igual"
    fi
    # next start sobre la build. ENVFILE=env/production.env (== package.json `start`).
    blue "  ▶ admin-web (next start :$port · buildeado) → log: $logf"
    (
      cd "$svc_dir" || exit 1
      exec env ENVFILE="env/production.env" pnpm exec next start -p "$port"
    ) >>"$logf" 2>&1 &
    echo $! > "$pidf"
  fi
  log "pid $(cat "$pidf")"
  # Reporte NO-mudo (espejo de biometric/tracking): si el proceso ya murió y el :$port no bindeó,
  # mostramos el motivo del log (puerto tomado, env faltante, build corrupta). next dev sigue VIVO
  # mientras compila ⇒ el kill -0 no da falso-muerto.
  sleep 2
  if ! kill -0 "$(cat "$pidf" 2>/dev/null)" 2>/dev/null && ! port_in_use "$port"; then
    red "  · admin-web: el proceso terminó al arrancar — motivo (de $logf):"
    tail -5 "$logf" | sed 's/^/      /'
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
  hdr "ESTABILIZACIÓN (servicios lentos: biometric/tracking/admin-web)"
  local timeout=60 line svc port dir kind health i code
  # admin-web incluido: next dev compila on-demand en el 1er hit (lento la 1ª vez) → esperarlo evita un ❌ falso en el tablero.
  for svc in biometric tracking admin-web; do
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
        2*|3[0-9][0-9]|401|403) green "OK ($code)"; break ;;  # 3xx: admin-web "/" → /login (307) = vivo (mismo criterio que health_probe/status).
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
  maps_up               # perfil maps (tiles/ruteo/geocoding soberano) — best-effort, se salta sin datos preparados.
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
  # admin-web (Next.js): `next dev/start` (PADRE `pnpm exec` + `node …next dev -p 5001` manager) spawnea un
  # WORKER hijo (`next-server`) que BINDEA el :5001. El worker ya lo cazó el kill por puerto (b) — admin-web
  # está en SERVICES con :5001. Acá rematamos manager+padre por patrón SCOPEADO AL PUERTO (ambos llevan
  # `-p 5001` en su cmdline). NUNCA un `next dev`/`next-server` PELADO: mataría el Next de OTRO proyecto de la
  # flota (ej. take_photo:3137) — pisar otro proyecto en silencio es justo lo que la regla de puertos prohíbe.
  pkill -f "next dev -p 5001" 2>/dev/null && log "  pkill 'next dev -p 5001' (admin-web)" || true
  pkill -f "next start -p 5001" 2>/dev/null && log "  pkill 'next start -p 5001' (admin-web)" || true
  # otp-viewer: patrón por PATH del script (único en la máquina) — cubre el `node --watch` padre
  # cuyo worker ya cayó por puerto en (b).
  pkill -f "otp-viewer/server.mjs" 2>/dev/null && log "  pkill 'otp-viewer/server.mjs' (otp-viewer)" || true

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
        3[0-9][0-9]) hicon="✅"; hcolor="$C_GREEN"; hlabel="$hcode redirect"; ((up++)) ;;  # admin-web "/" → /login (307): vivo.
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

  # ── Drift de migraciones: la DB de un servicio quedó ATRÁS de su prisma/migrations
  # (típico tras 'restart <svc>' sin un boot full que migre). Es la red de payment.
  local drift; drift="$(migrate_drift)"
  if [[ -z "$drift" ]]; then
    printf '  %s✅ migraciones%s   todos los servicios al día con su prisma/migrations\n' "$C_GREEN" "$C_RESET"
  else
    printf '  %b⚠️  DRIFT de migraciones%b — la DB está ATRÁS; corré %bveo.sh migrate%b:\n' "$C_YEL$C_BOLD" "$C_RESET" "$C_BOLD" "$C_RESET"
    local s n
    while IFS='|' read -r s n; do
      [[ -n "$s" ]] && printf '     %s· %-14s %s migración(es) sin aplicar%s\n' "$C_YEL" "$s" "$n" "$C_RESET"
    done <<< "$drift"
  fi
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
        audit|media|panic|share|chat|booking|driver-bff|admin-bff)
          bash "$SCRIPT_DIR/boot-extra-services.sh" ;;
      esac ;;
    python) boot_biometric ;;
    go) boot_tracking ;;
    web) boot_admin_web ;;   # admin-web: el (re)build de Next vive DENTRO de boot_admin_web (no en el paso 2, que es solo node).
    mjs) boot_otp_viewer ;;  # otp-viewer: cero build — arranca directo.
  esac
  reconcile_pids
  echo
  cmd_status
}

# ── SUBCOMANDO: migrate ───────────────────────────────────────────────────────
cmd_migrate() { migrate_all; }

# ── BUILD (solo libs) ─────────────────────────────────────────────────────────
# En `dev` (watch) los SERVICIOS no se pre-buildean: `nest start --watch` los compila al vuelo.
# Pero las libs @veo/* SÍ se buildean primero — los servicios las importan desde su DIST (no src),
# así que sin su dist fresco el watch arranca contra tipos viejos.
build_libs() {
  hdr "BUILD LIBS (@veo/*)"
  blue "  packages (@veo/*) — los servicios importan su DIST; en watch NO se recompilan solas"
  if pnpm -r --filter "./packages/*" build; then
    green "  packages OK"
  else
    red "  ALGÚN package falló su build — los servicios dependen de @veo/*; REVISÁ esto antes de seguir."
  fi
}

# ── Detección de entorno productivo (defensiva) ───────────────────────────────
# El auto-seed es SOLO para dev/local. Si por lo que sea NODE_ENV o APP_ENV apuntan a
# producción, no sembramos NADA (los seeds .ts ya gatean NODE_ENV!=production por su
# cuenta, pero acá cortamos ANTES por las dudas).
dev_is_prod() {
  [[ "${NODE_ENV:-}" == "production" || "${APP_ENV:-development}" == "production" ]]
}

# ── Auto-seed BARATO de dev (identity + driver + media) ───────────────────────
# Estos 3 seeds solo piden postgres arriba + migraciones aplicadas (NO el stack node vivo),
# así que corren seguros tras migrate_all. Son idempotentes (upsert/ON CONFLICT). NUNCA
# abortan el boot: si uno falla, warning y seguimos — el stack ya está sano, el seed es
# conveniencia. Cada cmd_seed_* imprime su propio bloque con IDs/credenciales pegables.
dev_auto_seed() {
  blue "  🌱 Sembrando datos dev (identity/driver/media)… (idempotente · no rompe el boot)"
  cmd_seed_identity || yel "  ⚠ seed identity falló — sigo (el boot no se rompe por el seed)."
  cmd_seed_driver   || yel "  ⚠ seed driver falló — sigo."
  cmd_seed_media    || yel "  ⚠ seed media falló — sigo."
}

# ── SUBCOMANDO: dev (WATCH — todo en vivo) ────────────────────────────────────
# Igual que `up`, pero los servicios arrancan en WATCH (nest start --watch / uvicorn --reload):
# editás el SRC de un servicio → recompila y reinicia SOLO, sin tocar nada. La INFRA sigue en docker.
# admin-web ahora SÍ la gestiona veo.sh (next dev → HMR nativo de Next). Las APPS RN las compilás vos aparte.
# LÍMITE HONESTO (libs): los servicios importan @veo/* desde su DIST → un cambio en una lib NO se
# propaga solo (nest observa el src del servicio, no node_modules). tracking (Go) tampoco tiene watch.
# ⇒ tocaste una lib o tracking → `veo.sh restart <svc>` (o `veo.sh dev` de nuevo, que rebuildea libs).
# FLAGS: --no-seed (arranque pelado, sin auto-seed) · --seed-trips[=N] (siembra N viajes al final,
#        con el stack ya sano; default N=2; opt-in porque necesita kafka+trip+dispatch+admin-bff vivos).
cmd_dev() {
  # ── Parseo de flags (mismo estilo que el resto: loop while + case + shift) ──
  local do_seed=1 seed_trips=0 trips_n=2
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --no-seed)      do_seed=0 ;;
      --seed-trips)   seed_trips=1 ;;
      --seed-trips=*) seed_trips=1; trips_n="${1#*=}" ;;
      *) yel "  flag desconocido para 'dev': '$1' (válidos: --no-seed | --seed-trips[=N]) — lo ignoro." ;;
    esac
    shift
  done
  # Sanea N de trips (entero >=1; default 2). El tope real (6 conductores) lo aplica cmd_seed_trips.
  [[ "$trips_n" =~ ^[0-9]+$ ]] && (( trips_n >= 1 )) || trips_n=2

  printf '%s%s🔧 VEO · WATCH (dev en vivo)%s\n' "$C_BOLD" "$C_BLUE" "$C_RESET"
  infra_up_and_wait || { red "Infra no quedó healthy — ABORTO (los servicios la necesitan)."; exit 1; }
  maps_up               # perfil maps (tiles/ruteo/geocoding soberano) — best-effort, se salta sin datos preparados.
  gen_secrets
  build_libs            # servicios NO pre-buildeados: nest los compila al vuelo. Libs SÍ (se importan de dist).
  migrate_all

  # ── AUTO-SEED BARATO — la DB ya está lista (migrate_all aplicó migraciones) ──
  # Corre ANTES de bootear los servicios: los seeds baratos escriben directo a postgres.
  if dev_is_prod; then
    yel "  🌱 auto-seed SALTEADO (entorno productivo: NODE_ENV/APP_ENV=production)."
  elif (( ! do_seed )); then
    yel "  🌱 auto-seed SALTEADO (--no-seed) — arranque pelado, sin datos dev."
  else
    dev_auto_seed
  fi

  export VEO_WATCH=1    # ← el flag que boot-passenger/boot-extra/biometric leen para arrancar en watch.
  boot_all
  reconcile_pids
  wait_native_health    # estabiliza los lentos (biometric/tracking) ANTES del tablero.
  cmd_status

  # ── SEED TRIPS (opt-in) — al FINAL: necesita el stack COMPLETO y sano (kafka+trip+dispatch+admin-bff) ──
  if (( seed_trips )); then
    if dev_is_prod; then
      yel "  🚗 --seed-trips SALTEADO (entorno productivo)."
    else
      hdr "SEED TRIPS (--seed-trips=$trips_n · stack vivo)"
      cmd_seed_trips "$trips_n" || yel "  ⚠ seed trips falló — el stack sigue arriba igual."
    fi
  fi

  printf '\n%s%s✓ WATCH activo:%s editá el SRC de cualquier servicio → recompila y reinicia solo.\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
  yel " Cambiaste una LIB @veo/* o tracking (Go) → 'veo.sh restart <svc>' (o 'veo.sh dev' de nuevo)."
  yel " admin-web: gestionada por veo.sh (next dev/HMR). Apps RN: las compilás vos aparte."
  blue " 📲 OTP en vivo (driver/pasajero · SMS sandbox + email): visor web → http://localhost:5190/  (o 'veo.sh otp -f' en terminal)."
}

# ── SUBCOMANDO: otp (escáner de OTP de dev) ───────────────────────────────────
# En dev el SMS va por SANDBOX (no se manda nada real) — el código de CUALQUIER OTP (driver/pasajero,
# SMS o email) queda en notification.notifications.payload->>'code'. Este comando lo muestra con su
# destino. El admin usa TOTP (Google Authenticator), NO pasa por esta tabla, así que queda afuera solo.
#   veo.sh otp        → últimos OTP (tabla)
#   veo.sh otp -f     → EN VIVO: imprime cada OTP nuevo al aparecer (ideal para probar flows rápido)
otp_rows() {  # imprime newest-first:  epoch \t HH:MM:SS \t canal \t destino \t código \t estado
  docker exec "$PG_CONT" psql -U veo -d veo -t -A -F $'\t' -c \
    "SELECT extract(epoch from created_at)::bigint, to_char(created_at,'HH24:MI:SS'), channel,
            COALESCE(payload->>'to', payload->>'email', payload->>'recipient', '?'), payload->>'code', status
     FROM notification.notifications WHERE payload ? 'code'
     ORDER BY created_at DESC LIMIT ${1:-12};" 2>/dev/null
}
cmd_otp() {
  # grep POSIX, NO rg: rg vive en homebrew y no está en el PATH del bash del shebang (mismo motivo
  # que migrate_drift) — acá 'rg' fallaba silencioso y el comando mentía "postgres no está arriba".
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${PG_CONT}\$"; then
    red "  postgres ($PG_CONT) no está arriba — levantá la infra (veo.sh up / dev)"; return 1
  fi
  local follow=0
  [[ "${1:-}" == "-f" || "${1:-}" == "--follow" ]] && follow=1
  if (( ! follow )); then
    printf '%s%-9s %-6s %-22s %-8s %s%s\n' "$C_BOLD" "HORA" "CANAL" "DESTINO" "CÓDIGO" "ESTADO" "$C_RESET"
    otp_rows 12 | while IFS=$'\t' read -r ep t ch to code st; do
      [[ -z "$code" ]] && continue
      printf '%-9s %-6s %-22s %s%-8s%s %s\n' "$t" "$ch" "$to" "$C_BOLD$C_GREEN" "$code" "$C_RESET" "$st"
    done
    return 0
  fi
  blue "  📲 escáner OTP EN VIVO (Ctrl-C corta) · SMS sandbox + email · admin=TOTP aparte"
  local hw=0
  while true; do
    while IFS=$'\t' read -r ep t ch to code st; do
      [[ -z "$ep" || -z "$code" ]] && continue
      if (( ep > hw )); then
        hw=$ep
        printf '%s[OTP]%s %s  %-5s  %-22s  → %s%s%s  (%s)\n' \
          "$C_BOLD$C_GREEN" "$C_RESET" "$t" "$ch" "$to" "$C_BOLD$C_GREEN" "$code" "$C_RESET" "$st"
      fi
    done < <(otp_rows 8 | tail -r)
    sleep 1.5
  done
}

# ── SUBCOMANDO: trazar (gate determinista SCOPEADO) ───────────────────────────
# `trazar index .` en el ROOT compila los ~32 sub-proyectos del monorepo → cuelga >2min (no es un bug:
# trazar usa el compilador TS y el monorepo es grande). El gate por LOTE (00 §8) es SCOPEADO: indexá
# SOLO el paquete tocado (~2s) y corré veredicto + findings sobre ESO. Esto lo hace ergonómico.
#   veo.sh trazar <paquete>   → path (services/bff/admin-bff) o nombre suelto (admin-bff). Sin arg: lista.
cmd_trazar() {
  if ! command -v trazar >/dev/null 2>&1; then
    red "  'trazar' no está en el PATH — instalá/linkeá el CLI de trazabilidad"; return 1
  fi
  local target="${1:-}"
  if [[ -z "$target" ]]; then
    yel "  uso: veo.sh trazar <paquete>   (ej. 'services/bff/admin-bff' ó 'admin-bff')"
    blue "  el root entero cuelga (~32 paquetes); scopeá al que tocaste. Candidatos:"
    fd -t f -g 'tsconfig.json' "$ROOT_DIR/services" "$ROOT_DIR/apps" "$ROOT_DIR/packages" \
      -E node_modules -E dist 2>/dev/null | sed "s#$ROOT_DIR/##;s#/tsconfig.json##" | sort | sed 's/^/    /'
    return 1
  fi
  # Resolver el paquete: path directo con tsconfig, o búsqueda fuzzy por nombre de dir.
  local dir=""
  if [[ -f "$ROOT_DIR/$target/tsconfig.json" ]]; then
    dir="$ROOT_DIR/$target"
  elif [[ -f "$target/tsconfig.json" ]]; then
    dir="$target"
  else
    dir="$(fd -t d "$target" "$ROOT_DIR/services" "$ROOT_DIR/apps" "$ROOT_DIR/packages" \
      -E node_modules 2>/dev/null | while read -r d; do [[ -f "$d/tsconfig.json" ]] && { echo "$d"; break; }; done)"
  fi
  if [[ -z "$dir" || ! -f "$dir/tsconfig.json" ]]; then
    red "  no encontré un paquete con tsconfig.json para '$target' — corré 'veo.sh trazar' sin args para ver los candidatos"
    return 1
  fi
  hdr "TRAZAR (scopeado) · ${dir#"$ROOT_DIR"/}"
  blue "  index (solo este paquete — rápido) …"
  if ! trazar index "$dir"; then red "  index falló (revisá que el paquete compile)"; return 1; fi
  printf '\n'; trazar verdict "$dir" --fail-on-deadend; local v=$?
  printf '\n'; trazar findings "$dir"
  printf '\n'
  (( v == 0 )) && green "  ✓ gate OK (sin dead-ends)" || yel "  ⚠ el veredicto marcó algo (ver arriba) — revisá antes de entregar el lote"
  blue "  gate por LOTE: importan string-magico / n-plus-one / missing-transaction / promesa-flotante (within-package)."
  yel  "  'orphan-receiver'/'dead-end' acá son RUIDO del scoping de un lado (el otro extremo no está en el grafo)."
}

# ── SUBCOMANDOS: FINANZAS DEV (seed de pagos + triggers manuales de los crons) ─────────────────
# Alimentan las 3 pantallas de finanzas del admin (Liquidaciones · Reembolsos · Reconciliación) sin
# depender de webhooks reales. El dato de origen es un Payment FARE CAPTURED (viaje cobrado); en dev
# el riel corre en `prontopaga` (cobros nacen PENDING) → sin este seed las pantallas quedan VACÍAS.
#   seed-finance            siembra los cobros CAPTURED e imprime los tripIds (para Reembolsos).
#   run-payouts  [ini fin]  dispara el run de liquidación (POST /payouts/run). Default = semana previa.
#   run-reconcile [YYYY-MM-DD]  dispara la conciliación de un día (POST /reconciliation/run, dev-only). Default = ayer.
#
# Los dos triggers pegan al endpoint INTERNO de payment-service (:3005, prefijo /api/v1) FIRMANDO la
# identidad interna igual que el admin-bff: header `x-veo-identity` (base64url del JSON) + `x-veo-identity-sig`
# (HMAC-SHA256 hex con el INTERNAL_IDENTITY_SECRET compartido). Forjamos una identidad de riel ADMIN con rol
# FINANCE (lo exige el RolesGuard de esos endpoints). En dev el step-up MFA se omite (StepUpMfaGuard →
# !isHardenedEnv()), así que NO hace falta TOTP. El secreto se LEE del env de payment en runtime (boot-passenger
# lo sincroniza entre servicios) — nunca hardcodeado acá.

# Secreto HMAC de identidad interna que usa el payment-service CORRIENDO (del env que cargó al bootear).
finance_payment_secret() {
  local envf="$ROOT_DIR/services/payment-service/env/${APP_ENV:-development}.env"
  grep -m1 '^INTERNAL_IDENTITY_SECRET=' "$envf" 2>/dev/null | cut -d= -f2-
}

# Forja la identidad interna firmada (idéntica a signInternalIdentity de @veo/auth): imprime 2 líneas,
# HEADER y luego SIG. type='admin' (SubjectType del JWT en minúsculas), roles=[FINANCE], aud='admin-rail'.
# Usa node (mismo createHmac('sha256').digest('hex') que @veo/utils signHmac) para que la firma matchee bit a bit.
finance_forge_identity() {  # $1 = secret
  node -e '
    const c = require("crypto");
    const secret = process.argv[1];
    const id = { userId: "dev-finance-op", type: "admin", roles: ["FINANCE"], sessionId: "dev-finance-seed", issuedAt: Date.now(), aud: "admin-rail" };
    const header = Buffer.from(JSON.stringify(id)).toString("base64url");
    const sig = c.createHmac("sha256", secret).update(header).digest("hex");
    process.stdout.write(header + "\n" + sig + "\n");
  ' "$1"
}

# POST a un endpoint interno de payment-service con la identidad ADMIN/FINANCE firmada. $1=path, $2=body JSON.
finance_internal_post() {
  local path="$1" body="${2:-}"
  [[ -z "$body" ]] && body='{}'
  local line port secret hdr sig
  line="$(svc_line payment)" || { red "  servicio 'payment' desconocido en el mapa"; return 1; }
  IFS='|' read -r _ port _ _ _ <<<"$line"
  if ! command -v node >/dev/null 2>&1; then red "  falta node en PATH (necesario para firmar la identidad interna)"; return 1; fi
  if ! port_in_use "$port"; then
    red "  payment-service no responde en :$port — levantá el stack primero (veo.sh dev / up)"; return 1
  fi
  secret="$(finance_payment_secret)"
  if [[ -z "$secret" ]]; then
    red "  no pude leer INTERNAL_IDENTITY_SECRET del env de payment — ¿corriste el boot? (veo.sh up/dev sincroniza el secreto)"; return 1
  fi
  { read -r hdr; read -r sig; } < <(finance_forge_identity "$secret")
  blue "  POST http://localhost:$port$path  body=$body"
  curl -sS -X POST "http://localhost:$port$path" \
    -H 'content-type: application/json' \
    -H "x-veo-identity: $hdr" \
    -H "x-veo-identity-sig: $sig" \
    -w $'\n  ← HTTP %{http_code}\n' \
    --data "$body"
}

cmd_seed_finance() {
  hdr "SEED FINANZAS (pagos DEV → Liquidaciones/Reembolsos/Reconciliación)"
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${PG_CONT}\$"; then
    red "  postgres ($PG_CONT) no está arriba — levantá la infra (veo.sh up / dev)"; return 1
  fi
  if ! docker exec -i "$PG_CONT" psql -U veo -d veo -q < "$SCRIPT_DIR/seed-finance-dev.sql"; then
    red "  el seed falló (revisá el error de psql arriba)"; return 1
  fi
  green "  seed aplicado (idempotente: re-correr NO duplica ni rota los tripIds)"
  echo
  blue "  cobros CAPTURED sembrados — los tripIds son PEGABLES en la pantalla de Reembolsos:"
  printf '    %-38s %-8s %-18s\n' "TRIP_ID" "MONTO" "CAPTURADO (UTC)"
  docker exec "$PG_CONT" psql -U veo -d veo -t -A -F $'\t' -c \
    "SELECT trip_id, gross_cents, to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI')
     FROM payment.payments WHERE dedup_key LIKE 'seed-fare:%' ORDER BY captured_at;" 2>/dev/null \
  | while IFS=$'\t' read -r tid gross cap; do
      [[ -z "$tid" ]] && continue
      printf '    %-38s S/%-6s %-18s\n' "$tid" "$(awk "BEGIN{printf \"%.2f\", $gross/100}")" "$cap"
    done
  echo
  yel "  siguiente: 'veo.sh run-payouts' (Liquidaciones) · 'veo.sh run-reconcile' (Reconciliación)."
  blue "  Reembolsos ya se ve: reembolsá cualquiera de los tripIds recientes desde el panel."
}

cmd_seed_fleet() {
  hdr "SEED FLOTA (conductor PENDING + vehículo en revisión + docs/inspección → Conductores/Vehículos/Revisiones)"
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${PG_CONT}\$"; then
    red "  postgres ($PG_CONT) no está arriba — levantá la infra (veo.sh up / dev)"; return 1
  fi
  if ! docker exec -i "$PG_CONT" psql -U veo -d veo -q < "$SCRIPT_DIR/seed-fleet-dev.sql"; then
    red "  el seed falló (revisá el error de psql arriba)"; return 1
  fi
  green "  seed aplicado (idempotente: re-correr NO duplica y RE-ARMA los estados PENDING para volver a probar)"
  echo
  blue "  IDs sembrados (PEGABLES para probar aprobar/rechazar en el panel de FLOTA):"
  printf '    %-16s %-38s %s\n' "QUÉ" "ID / PLACA" "ENCIENDE"
  printf '    %-16s %-38s %s\n' "conductor"  "d1000000-0000-4000-8000-0000000000a1" "Conductores (Pendientes/Todos) + Revisiones"
  printf '    %-16s %-38s %s\n' "  user_id"  "d1000000-0000-4000-8000-000000000001" "(sujeto de identidad del conductor)"
  printf '    %-16s %-38s %s\n' "vehículo"   "REV-456 · d1000000-…-0000000000b1"    "Vehículos ('En revisión' · operable=false/DOCS)"
  printf '    %-16s %-38s %s\n' "  doc SOAT"  "d1000000-0000-4000-8000-0000000000c1" "Revisiones (PENDING_REVIEW, VEHICLE)"
  printf '    %-16s %-38s %s\n' "  doc ITV"   "d1000000-0000-4000-8000-0000000000c2" "Revisiones (PENDING_REVIEW, VEHICLE)"
  printf '    %-16s %-38s %s\n' "  inspección" "d1000000-0000-4000-8000-0000000000e1" "Vehículos → columna ITV en 'Vigente'"
  echo
  blue "  estado real en la DB tras el seed:"
  docker exec "$PG_CONT" psql -U veo -d veo -t -A -F $'\t' -c \
    "SELECT 'conductor', legal_name, background_check_status::text FROM identity.drivers
      WHERE id='d1000000-0000-4000-8000-0000000000a1'
     UNION ALL
     SELECT 'doc '||type::text, status::text, to_char(coalesce(expires_at, now()) AT TIME ZONE 'UTC','YYYY-MM-DD')
      FROM fleet.fleet_documents WHERE owner_id='d1000000-0000-4000-8000-0000000000b1'
     UNION ALL
     SELECT 'ITV inspeccion', case when passed then 'passed' else 'failed' end,
      case when next_due_at>now() then 'vigente' else 'vencida' end
      FROM fleet.inspections WHERE vehicle_id='d1000000-0000-4000-8000-0000000000b1';" 2>/dev/null \
  | while IFS=$'\t' read -r what a b; do
      [[ -z "$what" ]] && continue
      printf '    %-20s %-24s %s\n' "$what" "$a" "$b"
    done
  echo
  yel "  'Todos' de Conductores lee el read-model Redis: el evento driver.registered del outbox lo proyecta."
  yel "  El relay corre en el identity-service VIVO — si el conductor NO sale en 'Todos', reiniciá identity"
  yel "  (o esperá al próximo tick del relay). En 'Pendientes' y 'Revisiones' aparece YA (leen identity/fleet directo)."
}

# ── SUBCOMANDO: SEED (orquestador de seeds DEV) ───────────────────────────────
# Unifica los seeds de dev en UN comando. Cada target siembra datos IDEMPOTENTES y
# reporta IDs/credenciales PEGABLES. `seed` sin arg corre los 3 que NO necesitan el
# stack de SERVICIOS vivo (solo postgres arriba): identity + driver + media. `seed
# trips` es orquestación aparte (requiere el stack vivo → un viaje real).

# Guard: postgres de infra arriba (todos los seeds escriben directo a la DB).
_seed_require_pg() {
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${PG_CONT}\$"; then
    red "  postgres ($PG_CONT) no está arriba — levantá la infra (veo.sh up / dev)"; return 1
  fi
}

# Corre el db:seed (tsx) de un servicio node sourceando su env/development.env (DATABASE_URL, etc.),
# igual que migrate_all. El seed .ts gatea NODE_ENV!=production por su cuenta.
_seed_node_pkg() {
  local dir="$1" filter="$2"
  ( cd "$ROOT_DIR/$dir" || exit 1
    set -a; export APP_ENV="${APP_ENV:-development}"
    [[ -f "env/${APP_ENV}.env" ]] && . "env/${APP_ENV}.env" 2>/dev/null
    set +a
    pnpm --filter "$filter" db:seed )
}

cmd_seed_identity() {
  hdr "SEED IDENTITY (admin SUPERADMIN + 6 operadores por rol · TOTP fijo de dev)"
  _seed_require_pg || return 1
  if ! _seed_node_pkg services/identity-service @veo/identity-service; then
    red "  el seed de identity falló (revisá el error arriba)"; return 1
  fi
  green "  seed aplicado (idempotente: upsert por email)"
  echo
  blue "  credenciales admin PEGABLES (login del admin-web · misma contraseña para todos):"
  printf '    %-24s %-22s %s\n' "EMAIL" "CONTRASEÑA" "ROL"
  printf '    %-24s %-22s %s\n' "admin@veo.pe"      "ChangeMe_VEO_2026!" "SUPERADMIN"
  printf '    %-24s %-22s %s\n' "admin-role@veo.pe" "ChangeMe_VEO_2026!" "ADMIN"
  printf '    %-24s %-22s %s\n' "dispatcher@veo.pe" "ChangeMe_VEO_2026!" "DISPATCHER"
  printf '    %-24s %-22s %s\n' "support-l1@veo.pe" "ChangeMe_VEO_2026!" "SUPPORT_L1"
  printf '    %-24s %-22s %s\n' "support-l2@veo.pe" "ChangeMe_VEO_2026!" "SUPPORT_L2"
  printf '    %-24s %-22s %s\n' "compliance@veo.pe" "ChangeMe_VEO_2026!" "COMPLIANCE_SUPERVISOR"
  printf '    %-24s %-22s %s\n' "finance@veo.pe"    "ChangeMe_VEO_2026!" "FINANCE"
  echo
  yel "  TOTP compartido de dev (Google Authenticator): JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP — el código vivo sale en el visor :5190."
}

cmd_seed_driver() {
  hdr "SEED DRIVER (conductor elegible + vehículo + docs de flota → simula viajes sin la driver-app)"
  _seed_require_pg || return 1
  if ! docker exec -i "$PG_CONT" psql -U veo -d veo -q < "$SCRIPT_DIR/seed-dev-driver.sql"; then
    red "  el seed de driver falló (revisá el error de psql arriba)"; return 1
  fi
  green "  seed aplicado (idempotente: ON CONFLICT)"
  echo
  blue "  IDs sembrados (conductor DEV elegible · PEGABLES):"
  printf '    %-12s %s\n' "user_id"   "d0000000-0000-4000-8000-000000000001  (Carlos Conductor · DRIVER/VERIFIED)"
  printf '    %-12s %s\n' "driver_id" "d0000000-0000-4000-8000-0000000000a1  (AVAILABLE · background CLEARED)"
  printf '    %-12s %s\n' "vehículo"  "d0000000-0000-4000-8000-0000000000b1  (Toyota Yaris · ADV-123 · docs VALID)"
}

cmd_seed_media() {
  hdr "SEED MEDIA (solicitudes de acceso a video en estados variados → panel Media/Solicitudes)"
  _seed_require_pg || return 1
  if ! _seed_node_pkg services/media-service @veo/media-service; then
    red "  el seed de media falló (revisá el error arriba)"; return 1
  fi
  green "  seed aplicado (idempotente: re-arma los PENDING para volver a probar)"
  echo
  blue "  solicitudes sembradas (IDs PEGABLES · probá aprobar/rechazar los PENDING):"
  printf '    %-38s %-9s %s\n' "ID" "ESTADO" "SOLICITANTE"
  printf '    %-38s %-9s %s\n' "b0a11ce0-0000-4000-8000-000000000001" "PENDING"  "dispatcher@veo.pe"
  printf '    %-38s %-9s %s\n' "b0a11ce0-0000-4000-8000-000000000002" "PENDING"  "support-l2@veo.pe"
  printf '    %-38s %-9s %s\n' "b0a11ce0-0000-4000-8000-000000000003" "APPROVED" "support-l2@veo.pe"
  printf '    %-38s %-9s %s\n' "b0a11ce0-0000-4000-8000-000000000004" "REJECTED" "support-l1@veo.pe"
  echo
  yel "  aprobar/rechazar = COMPLIANCE_SUPERVISOR con MFA fresca (login compliance@veo.pe). Cuatro-ojos: el aprobador ≠ el solicitante."
}

# ── SEED TRIPS (viajes reales → IN_PROGRESS por el PATH DE EVENTOS) ───────────────────────────────────
# El read-model `bff:rm:trips:s:IN_PROGRESS` lo escribe SOLO el consumer Kafka del admin-bff al recibir
# `trip.started`. PROHIBIDO escribir Redis a mano: acá disparamos el flujo REAL —
#   pasajero POST /trips → dispatch matchea (FIXED) → oferta `dispatch.offered` al sim conductor "Carlos" →
#   el sim ACEPTA el match → trip.match_found → ASSIGNED → el sim avanza la FSM accept→arriving→arrived→start
#   → `trip.started` → admin-bff proyecta IN_PROGRESS. El sim corre con SIM_STOP_AT=IN_PROGRESS (deja el
#   viaje EN CURSO, no lo completa). El modo del catálogo por defecto (veo_economico) es FIXED.
# Requiere el STACK VIVO (postgres+redis+kafka + trip:3092 + dispatch:3093 + admin-bff:4003 con su consumer).

# Secreto HMAC de identidad interna (mismo que firman los servicios y el sim). Fuente canónica: el archivo
# de dev-stack (idéntico al INTERNAL_IDENTITY_SECRET que cargaron trip/dispatch al bootear).
trips_internal_secret() {
  local sf="$SCRIPT_DIR/secrets/internal-identity-secret.txt"
  [[ -f "$sf" ]] && tr -d '\n' < "$sf"
}

# Forja la identidad PASAJERO firmada (public-rail) para POST /trips — idéntica a signInternalIdentity de
# @veo/auth (base64url del JSON + HMAC-SHA256 hex). trip-service acepta cualquier riel permitido; usamos
# public-rail por semántica (el pasajero entra por el public-bff). $1=secret $2=passengerId(uuid).
trips_forge_passenger() {
  node -e '
    const c = require("crypto");
    const [secret, passengerId] = [process.argv[1], process.argv[2]];
    const id = { userId: passengerId, type: "passenger", roles: [], sessionId: "dev-trip-seed", issuedAt: Date.now(), aud: "public-rail" };
    const header = Buffer.from(JSON.stringify(id)).toString("base64url");
    const sig = c.createHmac("sha256", secret).update(header).digest("hex");
    process.stdout.write(header + "\n" + sig + "\n");
  ' "$1" "$2"
}

# Forja la identidad CONDUCTOR firmada (driver-rail) — para completar el viaje anterior de un conductor en
# el reset (POST /trips/:id/complete deriva el driverId de @CurrentUser). $1=secret $2=driverId(perfil a-id).
trips_forge_driver() {
  node -e '
    const c = require("crypto");
    const [secret, driverId] = [process.argv[1], process.argv[2]];
    const id = { userId: "dev-sim-driver", type: "driver", roles: [], sessionId: "dev-trip-seed", driverId, issuedAt: Date.now(), aud: "driver-rail" };
    const header = Buffer.from(JSON.stringify(id)).toString("base64url");
    const sig = c.createHmac("sha256", secret).update(header).digest("hex");
    process.stdout.write(header + "\n" + sig + "\n");
  ' "$1" "$2"
}

# Libera al conductor a${idx} de un viaje anterior CLAVADO (SIM_STOP_AT lo dejó IN_PROGRESS) → el seed es
# RE-EJECUTABLE. Camino REAL: completa su(s) viaje(s) IN_PROGRESS (POST /complete → trip.completed → dispatch
# releaseDriver suelta el busy + admin-bff lo saca del read-model IN_PROGRESS). Backstop: DEL de las claves
# EFÍMERAS de dispatch (driver:busy/claim) por si quedó ocupado en un estado pre-IN_PROGRESS. $1=secret $2=idx.
trips_reset_driver() {
  local secret="$1" idx="$2" d hdr sig tids tid
  d="d0000000-0000-4000-8000-0000000000a${idx}"
  tids="$(docker exec -i "$PG_CONT" psql -U veo -d veo -tAc \
    "select id from trip.trips where driver_id='$d' and status='IN_PROGRESS'" 2>/dev/null)"
  for tid in $tids; do
    [[ -z "$tid" ]] && continue
    { read -r hdr; read -r sig; } < <(trips_forge_driver "$secret" "$d")
    curl -sS -X POST "http://localhost:${TRIPS_TRIP_PORT}/api/v1/trips/${tid}/complete" \
      -H 'content-type: application/json' -H "x-veo-identity: $hdr" -H "x-veo-identity-sig: $sig" \
      --data '{"cashCollected":true}' >/dev/null 2>&1
    blue "    reset: completé el viaje anterior $tid del conductor $idx (libera al conductor)"
  done
  docker exec -i veo-redis redis-cli DEL "driver:busy:$d" "driver:claim:$d" >/dev/null 2>&1
}

# Crea UN viaje de pasajero (POST /api/v1/trips a trip-service :3092). Pickup EN el punto del sim para que
# el matching asigne a Carlos. Modo FIXED (default del catálogo) → dispatch ofertará al sim. Imprime
# "tripId|status|dispatchMode" en éxito; vacío + return 1 si falló. $1=secret.
trips_create_one() {
  local secret="$1" pid hdr sig resp body
  pid="$(node -e 'process.stdout.write(require("crypto").randomUUID())')"
  { read -r hdr; read -r sig; } < <(trips_forge_passenger "$secret" "$pid")
  body="$(printf '{"passengerId":"%s","origin":{"lat":%s,"lon":%s},"destination":{"lat":%s,"lon":%s},"paymentMethod":"CASH","category":"veo_economico"}' \
    "$pid" "$TRIPS_ORIGIN_LAT" "$TRIPS_ORIGIN_LON" "$TRIPS_DEST_LAT" "$TRIPS_DEST_LON")"
  resp="$(curl -sS -X POST "http://localhost:${TRIPS_TRIP_PORT}/api/v1/trips" \
    -H 'content-type: application/json' \
    -H "x-veo-identity: $hdr" -H "x-veo-identity-sig: $sig" \
    --data "$body" 2>/dev/null)"
  node -e '
    let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
      try { const j=JSON.parse(d);
        if (!j.id) { process.stderr.write(d); process.exit(2); }
        process.stdout.write(j.id+"|"+(j.status||"?")+"|"+(j.dispatchMode||"?"));
      } catch { process.stderr.write(d); process.exit(2); }
    });' <<<"$resp"
}

# Estado ACTUAL de un viaje en postgres (para detectar EXPIRED/CANCELLED cuando el matching no asignó).
trips_pg_status() {
  docker exec -i "$PG_CONT" psql -U veo -d veo -tAc "select status from trip.trips where id='$1'" 2>/dev/null | tr -d '[:space:]'
}

# ¿el viaje ya está en el read-model IN_PROGRESS del admin-bff? (miembro del ZSET). 0 = sí.
trips_in_progress() {
  local sc
  sc="$(docker exec -i veo-redis redis-cli ZSCORE bff:rm:trips:s:IN_PROGRESS "$1" 2>/dev/null)"
  [[ -n "$sc" ]]
}

# Siembra el conductor dev #idx elegible (idx 1..6). idx=1 = Carlos (el seed-dev-driver.sql existente, sin
# tocar). idx>=2 = conductor derivado con UUIDs por índice (user ...00${idx}, driver ...a${idx},
# vehículo ...b${idx}), idéntico a Carlos en elegibilidad. Idempotente (ON CONFLICT). $1=idx.
trips_ensure_driver() {
  local idx="$1"
  if [[ "$idx" == "1" ]]; then
    docker exec -i "$PG_CONT" psql -U veo -d veo -q < "$SCRIPT_DIR/seed-dev-driver.sql" >/dev/null 2>&1
    return $?
  fi
  local u="d0000000-0000-4000-8000-00000000000${idx}"
  local d="d0000000-0000-4000-8000-0000000000a${idx}"
  local v="d0000000-0000-4000-8000-0000000000b${idx}"
  docker exec -i "$PG_CONT" psql -U veo -d veo -q >/dev/null 2>&1 <<SQL
INSERT INTO identity.users (id, phone, name, type, kyc_status, kyc_verified_at, created_at, updated_at)
VALUES ('$u', '+51988${idx}00000', 'Conductor DEV ${idx}', 'DRIVER', 'VERIFIED', now(), now(), now())
ON CONFLICT (id) DO UPDATE SET type='DRIVER', kyc_status='VERIFIED', kyc_verified_at=now(), updated_at=now();

INSERT INTO identity.drivers (id, user_id, current_status, background_check_status, face_embedding,
  license_number, legal_name, average_rating, total_trips, last_verified_at, created_at, updated_at)
VALUES ('$d', '$u', 'AVAILABLE', 'CLEARED', '{}', 'LIC-DEV-00${idx}', 'Conductor DEV ${idx}', 4.90, 100, now(), now(), now())
ON CONFLICT (user_id) DO UPDATE SET current_status='AVAILABLE', background_check_status='CLEARED', suspended_at=NULL, updated_at=now();

INSERT INTO fleet.vehicles (id, plate, make, model, year, color, vehicle_type, driver_id, doc_status, active,
  insurance_expires_at, created_at, updated_at)
VALUES ('$v', 'DEV-00${idx}', 'Toyota', 'Yaris', 2022, 'Plomo', 'CAR', '$u', 'VALID', true, now()+interval '1 year', now(), now())
ON CONFLICT (id) DO UPDATE SET driver_id='$u', doc_status='VALID', active=true, insurance_expires_at=now()+interval '1 year', updated_at=now();

INSERT INTO fleet.fleet_documents (id, owner_type, owner_id, type, document_number, issued_at, expires_at, status, verified_at, created_at, updated_at)
VALUES
 ('d0000000-0000-4000-8000-00000000d${idx}c1','DRIVER','$d','LICENSE_A1','Q-DEV${idx}', now()-interval '6 months', now()+interval '2 years','VALID',now(),now(),now()),
 ('d0000000-0000-4000-8000-00000000d${idx}c2','DRIVER','$d','BACKGROUND_CHECK','ANT-DEV${idx}', now()-interval '1 month', now()+interval '1 year','VALID',now(),now(),now()),
 ('d0000000-0000-4000-8000-00000000d${idx}c3','DRIVER','$d','SOAT','SOAT-DEV${idx}', now()-interval '1 month', now()+interval '1 year','VALID',now(),now(),now()),
 ('d0000000-0000-4000-8000-00000000d${idx}c4','DRIVER','$d','PROPERTY_CARD','PROP-DEV${idx}', now()-interval '1 year', now()+interval '5 years','VALID',now(),now(),now()),
 ('d0000000-0000-4000-8000-00000000d${idx}c5','DRIVER','$d','ITV','ITV-DEV${idx}', now()-interval '1 month', now()+interval '6 months','VALID',now(),now(),now())
ON CONFLICT (id) DO UPDATE SET status='VALID', expires_at=EXCLUDED.expires_at, verified_at=now(), updated_at=now();
SQL
}

# Crea UN viaje y lo espera hasta IN_PROGRESS (recrea, budget 2, si el matching lo deja EXPIRED). SERIAL:
# creá-esperá-siguiente garantiza que cada viaje tome un conductor AVAILABLE distinto (el previo ya quedó
# ocupado IN_PROGRESS). Imprime SOLO el tripId logrado por stdout (vacío + return 1 si no llegó). $1=secret.
# Los logs van a stderr para no contaminar el stdout capturado.
trips_one_to_inprogress() {
  local secret="$1" line tid st budget=2 deadline
  while (( budget > 0 )); do
    budget=$((budget - 1))
    if ! line="$(trips_create_one "$secret")"; then
      red "    createTrip falló: $line" >&2; return 1
    fi
    tid="${line%%|*}"
    blue "    → $line" >&2
    deadline=$(( $(date +%s) + 90 ))
    while (( $(date +%s) < deadline )); do
      if trips_in_progress "$tid"; then printf '%s' "$tid"; return 0; fi
      st="$(trips_pg_status "$tid")"
      case "$st" in
        EXPIRED|FAILED|CANCELLED*)
          yel "    ⚠ $tid quedó en $st (matching sin candidato) — reintento" >&2
          break ;;   # sale del wait → recrea si queda budget
      esac
      sleep 3
    done
    trips_in_progress "$tid" && { printf '%s' "$tid"; return 0; }
  done
  return 1
}

cmd_seed_trips() {
  hdr "SEED TRIPS (viajes reales → IN_PROGRESS por el path de eventos · stack vivo)"
  local count="${1:-2}"
  [[ "$count" =~ ^[0-9]+$ ]] && (( count >= 1 )) || count=2
  if (( count > 6 )); then yel "  máximo 6 conductores dev — limito a 6"; count=6; fi

  # Coords del pickup = el punto por defecto del sim (los conductores quedan EN el recojo → matching inmediato).
  local TRIPS_ORIGIN_LAT=-12.003267 TRIPS_ORIGIN_LON=-77.063354
  local TRIPS_DEST_LAT=-12.012100  TRIPS_DEST_LON=-77.045100
  local TRIPS_TRIP_PORT=3092

  # ── 1. PREFLIGHT: el stack necesario debe estar vivo (NO lo levantamos nosotros) ──
  local cont
  for cont in "$PG_CONT" veo-redis veo-kafka; do
    if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${cont}\$"; then
      red "  contenedor '$cont' no está arriba — levantá la infra primero: 'veo.sh dev'"; return 1
    fi
  done
  if [[ "$(health_code http://localhost:3092/health)" != "200" ]]; then
    red "  trip-service :3092 no responde — levantá 'veo.sh dev' primero"; return 1; fi
  if [[ "$(health_code http://localhost:3093/health)" != "200" ]]; then
    red "  dispatch-service :3093 no responde — levantá 'veo.sh dev' primero"; return 1; fi
  # admin-bff proyecta el read-model con SU consumer Kafka. /health puede dar 401 (guard global): basta que
  # el puerto RESPONDA (≠ 000). La prueba REAL de que su consumer proyecta es que los viajes lleguen abajo.
  if [[ "$(health_code http://localhost:4003/health)" == "000" ]]; then
    red "  admin-bff :4003 no responde — su consumer Kafka proyecta el read-model; levantá 'veo.sh dev'"; return 1; fi
  if ! command -v node >/dev/null 2>&1; then
    red "  falta node en PATH (se usa para firmar la identidad interna del pasajero)"; return 1; fi

  local secret; secret="$(trips_internal_secret)"
  if [[ -z "$secret" ]]; then
    red "  no pude leer el secreto interno ($SCRIPT_DIR/secrets/internal-identity-secret.txt)"; return 1; fi

  # ── 2. Sembrar N conductores elegibles (Carlos = idx 1; el resto derivados) ──
  # Cada conductor solo puede estar EN UN viaje; N viajes IN_PROGRESS simultáneos ⇒ N conductores + N sims.
  blue "  sembrando $count conductor(es) dev elegible(s)…"
  local i
  for (( i = 1; i <= count; i++ )); do
    if ! trips_ensure_driver "$i"; then red "  falló el seed del conductor $i"; return 1; fi
  done

  # Reset RE-EJECUTABLE: libera a cada conductor de un viaje anterior clavado (SIM_STOP_AT deja el viaje
  # IN_PROGRESS → el conductor queda ocupado). Sin esto una 2da corrida no matchea (busy) ni limpia el
  # read-model. Camino real (complete) + backstop efímero. Ver trips_reset_driver.
  blue "  liberando conductores de viajes anteriores (re-ejecutable)…"
  for (( i = 1; i <= count; i++ )); do trips_reset_driver "$secret" "$i"; done

  # ── 3. Arrancar N sims (uno por conductor) — cada uno en su PROPIO grupo de procesos (set -m) para
  #       poder matar el ÁRBOL entero (pnpm→tsx→node) con kill al grupo. SIM_STOP_AT=IN_PROGRESS. ──
  local -a sim_pids=() sim_logs=()
  local u d v log
  set -m
  for (( i = 1; i <= count; i++ )); do
    u="d0000000-0000-4000-8000-00000000000${i}"
    d="d0000000-0000-4000-8000-0000000000a${i}"
    v="d0000000-0000-4000-8000-0000000000b${i}"
    log="$(mktemp -t "veo-sim-trips-${i}.XXXXXX")"
    ( cd "$ROOT_DIR/services/dispatch-service" && \
        exec env INTERNAL_IDENTITY_SECRET="$secret" KAFKA_BROKERS=localhost:9094 SIM_STOP_AT=IN_PROGRESS \
          SIM_LAT="$TRIPS_ORIGIN_LAT" SIM_LON="$TRIPS_ORIGIN_LON" \
          SIM_USER_ID="$u" SIM_DRIVER_ID="$d" SIM_VEHICLE_ID="$v" \
          pnpm tsx scripts/sim-driver.ts ) >"$log" 2>&1 &
    sim_pids[$i]=$!
    sim_logs[$i]="$log"
    blue "  sim conductor $i (driver ...a${i}) PID/grupo=${sim_pids[$i]} · log: $log"
  done
  set +m

  # Mata el ÁRBOL de cada sim vía su grupo de procesos (negativo = grupo). Definido acá para ver los locales.
  _trips_kill_sims() {
    local p
    for p in ${sim_pids[@]+"${sim_pids[@]}"}; do
      [[ -n "$p" ]] || continue
      kill -TERM -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null
    done
    wait 2>/dev/null
    pkill -f 'scripts/sim-driver.ts' 2>/dev/null  # backstop por si algún hijo se reparentó
  }

  # ── 4. Esperar readiness de cada sim (su consumer Kafka unido al grupo) ──
  local ready j
  for (( i = 1; i <= count; i++ )); do
    ready=0
    for (( j = 0; j < 50; j++ )); do
      if grep -q 'SIM_CONSUMER_READY' "${sim_logs[$i]}" 2>/dev/null; then ready=1; break; fi
      if ! kill -0 "${sim_pids[$i]}" 2>/dev/null; then
        red "  el sim $i murió al arrancar:"; tail -n 20 "${sim_logs[$i]}" | sed 's/^/    /'
        _trips_kill_sims; return 1
      fi
      sleep 1
    done
    if (( ready == 0 )); then
      red "  el sim $i no quedó listo en 50s (consumer no unido):"; tail -n 20 "${sim_logs[$i]}" | sed 's/^/    /'
      _trips_kill_sims; return 1
    fi
  done
  green "  $count sim(s) listos (consumers unidos). Buffer de estabilización…"
  sleep 3

  # ── 5-6. Crear N viajes SECUENCIALMENTE, cada uno hasta IN_PROGRESS (uno por conductor) ──
  local -a ok=()
  local tid
  for (( i = 1; i <= count; i++ )); do
    if tid="$(trips_one_to_inprogress "$secret")" && [[ -n "$tid" ]]; then
      green "    ✅ viaje $i: $tid → IN_PROGRESS"; ok[$i]="$tid"
    else
      yel "    ✗ viaje $i no llegó a IN_PROGRESS"
    fi
  done

  # ── 7. Bajar los sims ──
  echo
  blue "  bajando $count sim(s)…"
  _trips_kill_sims

  # ── Reporte final (leído del read-model REAL) ──
  local got=0 t
  for t in ${ok[@]+"${ok[@]}"}; do [[ -n "$t" ]] && got=$((got + 1)); done
  echo
  blue "  read-model bff:rm:trips:s:IN_PROGRESS ahora:"
  docker exec -i veo-redis redis-cli ZRANGE bff:rm:trips:s:IN_PROGRESS 0 -1 2>/dev/null | sed 's/^/    /'
  if (( got == count )); then
    green "  seed trips OK — $got/$count viaje(s) en IN_PROGRESS por el path real de eventos."
    return 0
  fi
  yel  "  seed trips incompleto — $got/$count en IN_PROGRESS. Logs de sim: ${sim_logs[*]+"${sim_logs[*]}"}"
  yel  "  causas típicas: matching sin candidato (eligibilidad del conductor), admin-bff consumer caído, o Kafka lento."
  return 1
}

# Dispatcher interno por target. Sin arg (o 'all') corre identity+driver+media (los que solo piden postgres).
cmd_seed() {
  local target="${1:-all}"
  local arg2="${2:-}"
  case "$target" in
    identity) cmd_seed_identity ;;
    driver)   cmd_seed_driver ;;
    media)    cmd_seed_media ;;
    trips)    cmd_seed_trips "$arg2" ;;
    all|"")
      cmd_seed_identity || return 1
      cmd_seed_driver   || return 1
      cmd_seed_media    || return 1
      hdr "RESUMEN SEED DEV (consolidado)"
      blue "  admin:    admin@veo.pe / ChangeMe_VEO_2026!  (SUPERADMIN) + 6 roles (dispatcher/support-l1/support-l2/compliance/finance/admin-role @veo.pe · misma pass)"
      blue "  TOTP dev: JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP  (código vivo en el visor :5190)"
      blue "  driver:   user d0000000-…-000000000001 · driver d0000000-…-0000000000a1 · vehículo d0000000-…-0000000000b1 (ADV-123)"
      blue "  media:    4 solicitudes b0a11ce0-…-0000000000{01..04}  (2 PENDING · 1 APPROVED · 1 REJECTED)"
      yel  "  NO incluye trips (requiere el stack vivo): corré 'veo.sh seed trips' aparte."
      ;;
    *)
      red "  target de seed desconocido: '$target' (usá: identity | driver | media | trips | <vacío>=identity+driver+media)"; return 1 ;;
  esac
}

cmd_run_payouts() {
  hdr "RUN PAYOUTS (disparo manual del cron semanal de liquidación)"
  local body='{}'
  if [[ -n "${1:-}" ]]; then
    # periodStart [periodEnd] en ISO (ej. 2026-06-29T00:00:00Z). Default (sin args) = semana previa (lo calcula el servicio).
    body="{\"periodStart\":\"$1\"${2:+,\"periodEnd\":\"$2\"}}"
  fi
  finance_internal_post /api/v1/payouts/run "$body"
  echo
  yel "  el run AGREGA los PENDING faltantes y los DESEMBOLSA (riel sandbox en dev) — refrescá Liquidaciones."
}

cmd_run_reconcile() {
  hdr "RUN RECONCILE (disparo manual del cron diario de conciliación · dev-only)"
  local body='{}'
  [[ -n "${1:-}" ]] && body="{\"date\":\"$1\"}"   # YYYY-MM-DD (UTC). Default (sin arg) = día previo.
  finance_internal_post /api/v1/reconciliation/run "$body"
  echo
  yel "  crea una ReconciliationRun (visible en el panel). OJO: en modo prontopaga getStatement()=[] →"
  yel "  la discrepancia sale ALTA (extracto vacío vs DB con cobros) y la corrida queda 'alerted'. Es esperado en dev."
}

cmd_login() {
  # Delega en login.mjs (node nativo, cero deps): calcula el TOTP vivo, hace POST /auth/login contra
  # admin-bff y devuelve las cookies veo_at/veo_rt listas para chrome-devtools / curl. --json para pipes.
  # En --json NO imprimimos el header: stdout debe ser JSON PURO para consumir por pipe.
  local json=0; for a in "$@"; do [[ "$a" == "--json" ]] && json=1; done
  [[ $json -eq 0 ]] && hdr "LOGIN ADMIN DEV (auto-TOTP → cookies de sesión pegables)"
  node "$SCRIPT_DIR/login.mjs" "$@"
}

# ── Dispatcher ────────────────────────────────────────────────────────────────
case "${1:-}" in
  up)      cmd_up ;;
  dev)     shift; cmd_dev "$@" ;;
  down)    shift; cmd_down "${1:-}" ;;
  status)  cmd_status ;;
  monitor) cmd_monitor ;;
  restart) shift; cmd_restart "${1:-}" ;;
  logs)    shift; cmd_logs "${1:-}" "${2:-}" ;;
  migrate) cmd_migrate ;;
  otp)     shift; cmd_otp "${1:-}" ;;
  trazar)  shift; cmd_trazar "${1:-}" ;;
  seed)          shift; cmd_seed "${1:-}" "${2:-}" ;;
  seed-finance)  cmd_seed_finance ;;
  seed-fleet)    cmd_seed_fleet ;;
  run-payouts)   shift; cmd_run_payouts "${1:-}" "${2:-}" ;;
  run-reconcile) shift; cmd_run_reconcile "${1:-}" ;;
  login)         shift; cmd_login "$@" ;;
  *)
    cat <<EOF
${C_BOLD}veo.sh${C_RESET} · ignición + apagado + tablero del stack de dev VEO

  ${C_BOLD}up${C_RESET}                 Ignición completa (infra → secrets → build → migrate → boot → tablero)
  ${C_BOLD}dev${C_RESET} [--no-seed] [--seed-trips[=N]]
                     Como 'up' pero servicios en WATCH (nest --watch/uvicorn --reload): editás src → reinicia solo.
                     AUTO-SIEMBRA barato (identity/driver/media) tras migrar · --no-seed lo saltea ·
                     --seed-trips[=N] (default 2) siembra viajes AL FINAL (opt-in: requiere el stack vivo)
  ${C_BOLD}down${C_RESET} [--infra]     Apagado limpio en capas (pidfiles → puertos → patrón). --infra baja docker
  ${C_BOLD}status${C_RESET}             El tablero (health/pid/dist/último error por servicio + infra)
  ${C_BOLD}monitor${C_RESET}            El escáner EN VIVO: sigue todos los logs y muestra solo errores al pasar
  ${C_BOLD}restart${C_RESET} <svc>      down + build + boot de ESE servicio
  ${C_BOLD}logs${C_RESET} <svc> [-f]    tail (o tail -f) de dev-stack/logs/<svc>.log
  ${C_BOLD}migrate${C_RESET}            prisma migrate deploy de todos los servicios (idempotente)
  ${C_BOLD}otp${C_RESET} [-f]           Escáner de OTP de dev (driver/pasajero · SMS sandbox + email). -f = en vivo. Admin=TOTP aparte
  ${C_BOLD}trazar${C_RESET} <paquete>   Gate determinista SCOPEADO (index + veredicto + findings de UN paquete · ~2s). El root cuelga (~32 pkgs)

  ${C_BOLD}seed-finance${C_RESET}       Siembra pagos DEV CAPTURED (para Liquidaciones/Reembolsos/Reconciliación) e imprime los tripIds
  ${C_BOLD}seed-fleet${C_RESET}         Siembra FLOTA DEV: conductor PENDING + vehículo en revisión + docs/inspección (Conductores/Vehículos/Revisiones) e imprime los IDs
  ${C_BOLD}run-payouts${C_RESET} [i f]  Dispara el run de liquidación (POST /payouts/run · FINANCE firmado). Default = semana previa
  ${C_BOLD}run-reconcile${C_RESET} [d]  Dispara la conciliación de un día (POST /reconciliation/run · dev-only). [d]=YYYY-MM-DD, default ayer
  ${C_BOLD}login${C_RESET} [--json]     Auto-login admin dev (TOTP vivo → cookies veo_at/veo_rt pegables para chrome-devtools/curl). --json = para pipes
  ${C_BOLD}seed${C_RESET} [target]      Orquesta seeds DEV idempotentes: ${C_BOLD}identity${C_RESET}(admin+6 roles+TOTP) · ${C_BOLD}driver${C_RESET}(conductor+vehículo+docs) · ${C_BOLD}media${C_RESET}(accesos a video). Sin arg = los 3
  ${C_BOLD}seed trips${C_RESET} [N]    Siembra N viajes (default 2) hasta IN_PROGRESS por el PATH REAL de eventos (pasajero→dispatch→sim conductor→trip.started→read-model). Requiere el stack vivo

  servicios: $(printf '%s ' "${SERVICES[@]%%|*}")
EOF
    exit 1 ;;
esac
