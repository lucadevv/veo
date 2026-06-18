#!/usr/bin/env bash
# gen-missing-secrets.sh · Inyecta los secretos DEV de los servicios FUERA del boot-passenger
# directamente en su env/development.env (convención env ÚNICA: un solo env/<tier>.env por servicio,
# GITIGNORED). Idempotente POR CLAVE (append-if-absent / replace-if-empty): NO pisa la config ya
# presente y NO duplica claves. Reusa los secretos compartidos de dev-stack/secrets/.
set -euo pipefail

DEV_STACK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DEV_STACK/.." && pwd)"
SECRETS="$DEV_STACK/secrets"
SVCS="$ROOT/services"
UPSERT="node $DEV_STACK/lib/upsert-env.mjs"

INTERNAL_SECRET="$(tr -d '\n' < "$SECRETS/internal-identity-secret.txt")"
MAPBOX="$(tr -d '\n' < "$SECRETS/mapbox-access-token.txt")"
PUBLIC_PEM="$SECRETS/jwt-es256-public.spki.pem"

# HMAC propios estables (se generan una vez, se reusan)
[[ -f "$SECRETS/panic-hmac-secret.txt" ]] || openssl rand -hex 32 > "$SECRETS/panic-hmac-secret.txt"
[[ -f "$SECRETS/share-link-secret.txt" ]] || openssl rand -hex 32 > "$SECRETS/share-link-secret.txt"
PANIC_HMAC="$(tr -d '\n' < "$SECRETS/panic-hmac-secret.txt")"
SHARE_LINK="$(tr -d '\n' < "$SECRETS/share-link-secret.txt")"

LIVEKIT_SECRET="devsecret_change_in_production"
CLICKHOUSE_PASS="veo_dev"

# inyecta los secretos en el env/development.env del servicio (append-if-absent / replace-if-empty,
# idempotente por clave). El development.env YA EXISTE con config; NUNCA se recrea entero.
inject() { # <env/development.env path> <KEY=VALUE...>
  local f="$1"; shift
  if [[ ! -f "$f" ]]; then echo "  ✗ FALTA $f (la convención exige que development.env ya exista)"; return 1; fi
  $UPSERT "$f" "$@"
}

# --- services NestJS simples ---
inject "$SVCS/audit-service/env/development.env" "INTERNAL_IDENTITY_SECRET=$INTERNAL_SECRET"
inject "$SVCS/chat-service/env/development.env"  "INTERNAL_IDENTITY_SECRET=$INTERNAL_SECRET"
inject "$SVCS/media-service/env/development.env" "INTERNAL_IDENTITY_SECRET=$INTERNAL_SECRET" "LIVEKIT_API_SECRET=$LIVEKIT_SECRET"
inject "$SVCS/panic-service/env/development.env" "INTERNAL_IDENTITY_SECRET=$INTERNAL_SECRET" "PANIC_HMAC_SECRET=$PANIC_HMAC"
inject "$SVCS/share-service/env/development.env" "SHARE_LINK_SECRET=$SHARE_LINK" "INTERNAL_IDENTITY_SECRET=$INTERNAL_SECRET"
inject "$SVCS/tracking-service/env/development.env" "CLICKHOUSE_PASSWORD=$CLICKHOUSE_PASS" "MQTT_USERNAME=" "MQTT_PASSWORD="

# --- BFFs (PEM multilínea quoted, como public-bff) — el helper envuelve el PEM en comillas ---
PUBLIC_PEM_CONTENT="$(cat "$PUBLIC_PEM")"
inject "$SVCS/bff/driver-bff/env/development.env" \
  "VEO_JWT_PUBLIC_PEM=$PUBLIC_PEM_CONTENT" "VEO_INTERNAL_IDENTITY_SECRET=$INTERNAL_SECRET" "MAPBOX_ACCESS_TOKEN=$MAPBOX"
inject "$SVCS/bff/admin-bff/env/development.env" \
  "VEO_JWT_PUBLIC_PEM=$PUBLIC_PEM_CONTENT" "VEO_INTERNAL_IDENTITY_SECRET=$INTERNAL_SECRET" "CLICKHOUSE_PASSWORD=$CLICKHOUSE_PASS"

echo "Listo."
