#!/usr/bin/env bash
# Simula el webhook de cobro de ProntoPaga (Yape) contra el payment-service LOCAL.
#
# POR QUÉ EXISTE: en dev el riel corre en `prontopaga` (los cobros nacen PENDING, ver header de
# FINANZAS DEV en veo.sh) y el webhook real del agregador jamás llega a localhost → el pasajero
# queda clavado en "Completa tu pago" tras un viaje con Yape. Este script forja el webhook
# firmado igual que el proveedor (HMAC-SHA256 sobre clave+valor ordenado alfabético, campo `sign`
# — espejo de prontopaga.signer.ts) y captura el cobro. SOLO dev: el secret sale del env file
# local del servicio, el endpoint es localhost.
#
# Uso:
#   dev-stack/simulate-yape-webhook.sh              # captura el último Payment PENDING
#   dev-stack/simulate-yape-webhook.sh <paymentId>  # captura ese Payment puntual
#   dev-stack/simulate-yape-webhook.sh <paymentId> rejected  # simula rechazo (default: success)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_ENV="${APP_ENV:-development}"
ENVF="$ROOT_DIR/services/payment-service/env/${APP_ENV}.env"
PG_CONT="${PG_CONT:-veo-postgres}"

SECRET="$(grep -m1 '^PRONTOPAGA_SECRET_KEY=' "$ENVF" | cut -d= -f2-)"
[[ -z "$SECRET" ]] && { echo "✖ no hay PRONTOPAGA_SECRET_KEY en $ENVF" >&2; exit 1; }

PAYMENT_ID="${1:-}"
if [[ -z "$PAYMENT_ID" ]]; then
  PAYMENT_ID="$(docker exec "$PG_CONT" psql -U veo -d veo -t -A -c \
    "SELECT id FROM payment.payments WHERE status='PENDING' ORDER BY created_at DESC LIMIT 1;")"
  [[ -z "$PAYMENT_ID" ]] && { echo "✖ no hay Payments PENDING" >&2; exit 1; }
fi

UID_EXT="$(docker exec "$PG_CONT" psql -U veo -d veo -t -A -c \
  "SELECT external_uid FROM payment.payments WHERE id='${PAYMENT_ID}';")"
[[ -z "$UID_EXT" ]] && { echo "✖ Payment ${PAYMENT_ID} sin external_uid (¿existe?)" >&2; exit 1; }

STATUS="${2:-success}"

BODY="$(SECRET="$SECRET" node -e '
  const { createHmac } = require("crypto");
  const payload = { order: process.argv[1], uid: process.argv[2], status: process.argv[3] };
  const base = Object.keys(payload).sort().reduce((a, k) => a + k + String(payload[k]), "");
  payload.sign = createHmac("sha256", process.env.SECRET).update(base, "utf8").digest("hex");
  process.stdout.write(JSON.stringify(payload));
' "$PAYMENT_ID" "$UID_EXT" "$STATUS")"

echo "→ webhook ${STATUS} para Payment ${PAYMENT_ID} (uid ${UID_EXT})"
curl -sS -X POST http://localhost:3005/api/v1/webhooks/prontopaga \
  -H 'content-type: application/json' --data "$BODY" -w $'\n← HTTP %{http_code}\n'
