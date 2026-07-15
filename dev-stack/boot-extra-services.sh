#!/usr/bin/env bash
# boot-extra-services.sh · Arranca los servicios NestJS que el boot-passenger NO toca.
# (audit, media, panic, share, chat, booking) + driver-bff + admin-bff. Idempotente por puerto.
set -uo pipefail

DEV_STACK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DEV_STACK/.." && pwd)"
LOGS="$DEV_STACK/logs"; mkdir -p "$LOGS"
PIDS="$DEV_STACK/.pids"; mkdir -p "$PIDS"

port_in_use() { lsof -ti "tcp:$1" -sTCP:LISTEN >/dev/null 2>&1; }

start_node() { # <name> <dir> <port>
  local name="$1" dir="$ROOT/$2" port="$3"
  if port_in_use "$port"; then echo "  · $name ya corre en $port"; return; fi
  # Migraciones automáticas al boot (idempotente): aplica las pendientes ANTES de arrancar — mata el
  # drift de schema. Si falla, NO arranca (fail-fast honesto, no a medias). node queda en background.
  if ! (
    cd "$dir"
    # Tier por APP_ENV (regla ENTORNOS §5); default development (local-nativo).
    tier="${APP_ENV:-development}"
    # Convención env ÚNICA: un solo env/<tier>.env por servicio (config + secretos mergeados, GITIGNORED).
    set -a; export APP_ENV="$tier"; . "env/${tier}.env" 2>/dev/null; set +a
    if [ -d prisma/migrations ]; then
      npx prisma migrate deploy > "$LOGS/$name.log" 2>&1 || exit 1
    fi
    # WATCH (VEO_WATCH=1): el script `dev` (= nest start --watch) recompila y reinicia ante cada cambio
    # de SRC. Normal: el binario ya compilado. El `down` de veo.sh reapea los watchers (pkill 'nest start').
    if [ "${VEO_WATCH:-0}" = "1" ]; then
      nohup pnpm run dev >> "$LOGS/$name.log" 2>&1 & echo $! > "$PIDS/$name.pid"
    else
      nohup node dist/main.js >> "$LOGS/$name.log" 2>&1 & echo $! > "$PIDS/$name.pid"
    fi
  ); then
    echo "  ✗ $name migrate deploy FALLÓ — NO arrancó (ver $LOGS/$name.log)"; return
  fi
  echo "  ▶ $name lanzado (puerto $port, log $LOGS/$name.log)$([ "${VEO_WATCH:-0}" = "1" ] && printf ' · WATCH')"
}

start_node audit      services/audit-service       3009
start_node media      services/media-service       3007
start_node panic      services/panic-service       3006
start_node share      services/share-service       3011
start_node chat       services/chat-service         3014
start_node booking    services/booking-service      3016
start_node driver-bff services/bff/driver-bff       4002
start_node admin-bff  services/bff/admin-bff        4003

echo "Esperando health (hasta 40s)…"
for i in $(seq 1 40); do
  ok=1
  for hp in audit:3009 media:3007 panic:3006 share:3011 chat:3014 booking:3016 driver-bff:4002 admin-bff:4003; do
    p="${hp#*:}"
    curl -sf "http://localhost:$p/health" >/dev/null 2>&1 || ok=0
  done
  [ "$ok" = 1 ] && { echo "✅ los 8 responden /health"; break; }
  sleep 1
done
