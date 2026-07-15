#!/usr/bin/env bash
#
# migrate-preview.sh · Aplica las migraciones Prisma de TODOS los servicios NestJS en el VPS preview.
#
# POR QUÉ EXISTE: las imágenes corren `CMD node dist/main.js` (no migran al boot) y el compose no tiene
# job de migración → un deploy fresco deja la DB SIN schema (los servicios arrancan, /health pasa, pero
# toda query falla con "relation does not exist"). Este script es el "migra todo" reproducible que el
# deploy DEBE correr tras cada `pull` (lo invoca el job deploy del CI y se puede correr a mano en el VPS).
#
# Cómo: por cada servicio, corre un contenedor EFÍMERO desde su imagen (`run --rm`, no necesita el
# servicio levantado) con su env_file (trae DATABASE_URL) y ejecuta `prisma migrate deploy` (idempotente:
# solo aplica las PENDIENTES). El CLI `prisma` está en la imagen (es dependency de prod, no dev).
#
# Uso (en el VPS, desde /opt/veo):  bash infra/deploy/migrate-preview.sh
#   COMPOSE=docker-compose.preview.yml  bash infra/deploy/migrate-preview.sh   # override del archivo
set -euo pipefail

COMPOSE="${COMPOSE:-docker-compose.preview.yml}"

# Servicios NestJS con prisma/migrations (los BFFs y los servicios Go/Python NO migran acá).
SERVICES=(
  identity-service trip-service dispatch-service payment-service panic-service
  media-service notification-service audit-service rating-service share-service
  fleet-service places-service chat-service booking-service
)

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
blue()  { printf '\033[36m%s\033[0m\n' "$*"; }

blue "== migrate-preview :: ${#SERVICES[@]} servicios (compose: $COMPOSE) =="
failed=()
for svc in "${SERVICES[@]}"; do
  printf '  [%s] migrate deploy … ' "$svc"
  # run --rm: contenedor efímero con el env del servicio; no depende de que el servicio esté UP.
  # --entrypoint sh sortea el CMD (node dist/main.js) para ejecutar el CLI prisma.
  if docker compose -f "$COMPOSE" run --rm --no-deps --entrypoint sh "$svc" \
       -c 'npx prisma migrate deploy' >"/tmp/migrate-$svc.log" 2>&1; then
    green "OK"
  else
    red "FALLÓ (ver /tmp/migrate-$svc.log)"
    failed+=("$svc")
  fi
done

echo
if [ "${#failed[@]}" -eq 0 ]; then
  green "== TODAS las migraciones aplicadas (${#SERVICES[@]}/${#SERVICES[@]}) =="
else
  red "== FALLARON: ${failed[*]} =="
  exit 1
fi
