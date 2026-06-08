#!/usr/bin/env bash
# ============================================================================
# VEO · E2E golden path (cross-servicio orquestado)
#
# 1. Levanta la infra del dev-stack (Postgres/Redis/Kafka) si no está arriba.
# 2. Corre la suite vitest, que a su vez:
#    - compila @veo/* a dist,
#    - arranca identity/trip/dispatch/payment/panic + public-bff/driver-bff en background,
#    - espera el health de todos,
#    - ejecuta el golden path,
#    - apaga todos los procesos al terminar.
#
# Uso:
#   e2e/scripts/run-golden.sh            # levanta infra (si falta) y corre
#   E2E_GOLDEN=force ...                 # corre aunque el detector de infra dude
#   E2E_SKIP_BUILD=1 ...                 # no recompila @veo/* (si ya están en dist)
#   E2E_KEEP_INFRA=1 ...                 # no apaga el dev-stack al terminar
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "▶ Verificando infra del dev-stack…"
if ! docker compose -f dev-stack/docker-compose.yml ps --status running postgres redis kafka 2>/dev/null | grep -q kafka; then
  echo "▶ Levantando infra mínima (postgres redis kafka)…"
  docker compose -f dev-stack/docker-compose.yml up -d postgres redis kafka
  echo "▶ Esperando a que la infra acepte conexiones…"
  sleep 8
fi

echo "▶ Ejecutando la suite golden path…"
set +e
pnpm --filter @veo/e2e e2e:golden
CODE=$?
set -e

if [[ "${E2E_KEEP_INFRA:-0}" != "1" ]]; then
  echo "▶ (infra del dev-stack se deja arriba; usa 'pnpm dev-stack:down' para apagarla)"
fi

echo "▶ Logs de cada servicio/BFF en: e2e/.logs/"
exit $CODE
