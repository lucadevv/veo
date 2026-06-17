#!/usr/bin/env bash
# gen-missing-secrets.sh · Genera los development.secret.env de los servicios FUERA del boot-passenger.
# Idempotente: si el file ya existe, NO lo pisa. Reusa los secretos compartidos de dev-stack/secrets/.
set -euo pipefail

DEV_STACK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DEV_STACK/.." && pwd)"
SECRETS="$DEV_STACK/secrets"
SVCS="$ROOT/services"

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

write_if_absent() { # <path> <content>
  if [[ -f "$1" ]]; then echo "  · ya existe: ${1#$ROOT/}"; return; fi
  printf '%s\n' "$2" > "$1"; echo "  ✅ generado: ${1#$ROOT/}"
}

# --- services NestJS simples ---
write_if_absent "$SVCS/audit-service/env/development.secret.env" "INTERNAL_IDENTITY_SECRET=$INTERNAL_SECRET"
write_if_absent "$SVCS/chat-service/env/development.secret.env"  "INTERNAL_IDENTITY_SECRET=$INTERNAL_SECRET"
write_if_absent "$SVCS/media-service/env/development.secret.env" "INTERNAL_IDENTITY_SECRET=$INTERNAL_SECRET
LIVEKIT_API_SECRET=$LIVEKIT_SECRET"
write_if_absent "$SVCS/panic-service/env/development.secret.env" "INTERNAL_IDENTITY_SECRET=$INTERNAL_SECRET
PANIC_HMAC_SECRET=$PANIC_HMAC"
write_if_absent "$SVCS/share-service/env/development.secret.env" "SHARE_LINK_SECRET=$SHARE_LINK
INTERNAL_IDENTITY_SECRET=$INTERNAL_SECRET"
write_if_absent "$SVCS/tracking-service/env/development.secret.env" "CLICKHOUSE_PASSWORD=$CLICKHOUSE_PASS
MQTT_USERNAME=
MQTT_PASSWORD="

# --- BFFs (PEM multilínea quoted, como public-bff) ---
gen_bff_secret() { # <bff> <extra-line>
  local f="$SVCS/bff/$1/env/development.secret.env"
  if [[ -f "$f" ]]; then echo "  · ya existe: ${f#$ROOT/}"; return; fi
  { printf 'VEO_JWT_PUBLIC_PEM="'; cat "$PUBLIC_PEM"; printf '"\n';
    printf 'VEO_INTERNAL_IDENTITY_SECRET=%s\n' "$INTERNAL_SECRET";
    printf '%s\n' "$2"; } > "$f"
  echo "  ✅ generado: ${f#$ROOT/}"
}
gen_bff_secret driver-bff "MAPBOX_ACCESS_TOKEN=$MAPBOX"
gen_bff_secret admin-bff  "CLICKHOUSE_PASSWORD=$CLICKHOUSE_PASS"

echo "Listo."
