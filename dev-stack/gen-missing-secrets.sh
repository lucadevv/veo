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

# Detección/lectura de claves en PURO bash (sin rg/grep/sed): este script corre en el boot y NO debe depender
# de binarios no-POSIX que pueden faltar en el PATH del subproceso. `declares_key` = ¿el archivo declara KEY=?;
# `read_val` = imprime el valor de KEY= (primera ocurrencia).
declares_key() { # <file> <key>
  local line; while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in "$2="*) return 0 ;; esac
  done < "$1"; return 1
}
read_val() { # <file> <key>
  local line; while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in "$2="*) printf '%s' "${line#*=}"; return 0 ;; esac
  done < "$1"; return 1
}

# --- RAIL INTERNO (HMAC compartido): el dev-stack IMPONE el MISMO secreto a TODO consumidor ────────────────
# Los servicios verifican identidad interna con un HMAC compartido (INTERNAL_IDENTITY_SECRET); los BFFs FIRMAN
# con el mismo (VEO_INTERNAL_IDENTITY_SECRET). Si DOS servicios bootean con valores distintos, el rail responde
# 401 EN SILENCIO (no en el boot). Antes este script enumeraba a mano qué servicios recibían el secreto y se
# OLVIDÓ varios (booking entre ellos → 401 silencioso hasta arreglarlo a mano). Ahora DERIVAMOS la lista del
# CONTRATO (cada example.env declara la clave que el servicio consume) y la inyectamos con --force (un
# placeholder viejo NO sobrevive). Un servicio nuevo que declare la clave queda cubierto SIN tocar este script.
internal_consumers=0
for envex in "$SVCS"/*/env/example.env "$SVCS"/bff/*/env/example.env; do
  [[ -f "$envex" ]] || continue
  dev_env="$(dirname "$envex")/development.env"
  [[ -f "$dev_env" ]] || continue
  for key in INTERNAL_IDENTITY_SECRET VEO_INTERNAL_IDENTITY_SECRET; do
    if declares_key "$envex" "$key"; then
      $UPSERT --force "$dev_env" "${key}=$INTERNAL_SECRET"
      internal_consumers=$((internal_consumers + 1))
    fi
  done
done
echo "  rail interno: HMAC impuesto a $internal_consumers consumidores (derivados del contrato example.env)"

# --- extras específicos por servicio (el rail interno ya quedó cubierto arriba; acá solo lo PROPIO) ---
inject "$SVCS/media-service/env/development.env" "LIVEKIT_API_SECRET=$LIVEKIT_SECRET"
inject "$SVCS/panic-service/env/development.env" "PANIC_HMAC_SECRET=$PANIC_HMAC"
inject "$SVCS/share-service/env/development.env" "SHARE_LINK_SECRET=$SHARE_LINK"
inject "$SVCS/tracking-service/env/development.env" "CLICKHOUSE_PASSWORD=$CLICKHOUSE_PASS" "MQTT_USERNAME=" "MQTT_PASSWORD="

# --- BFFs: PEM de verificación JWT (multilínea quoted) + CLICKHOUSE/MAPBOX propios ---
PUBLIC_PEM_CONTENT="$(cat "$PUBLIC_PEM")"
inject "$SVCS/bff/driver-bff/env/development.env" "VEO_JWT_PUBLIC_PEM=$PUBLIC_PEM_CONTENT" "MAPBOX_ACCESS_TOKEN=$MAPBOX"
inject "$SVCS/bff/admin-bff/env/development.env" "VEO_JWT_PUBLIC_PEM=$PUBLIC_PEM_CONTENT" "CLICKHOUSE_PASSWORD=$CLICKHOUSE_PASS"

# --- VERIFY (enforce anti-drift): re-leemos y exigimos que TODO consumidor tenga EXACTAMENTE el secreto
# compartido. Con --force arriba el drift es imposible por construcción; este assert es el cinturón: si algún
# env quedó inconsistente (no escribible, glob fallido), el dev-stack ABORTA en vez de bootear un rail roto. ---
drift=0
for envex in "$SVCS"/*/env/example.env "$SVCS"/bff/*/env/example.env; do
  [[ -f "$envex" ]] || continue
  dev_env="$(dirname "$envex")/development.env"
  [[ -f "$dev_env" ]] || continue
  for key in INTERNAL_IDENTITY_SECRET VEO_INTERNAL_IDENTITY_SECRET; do
    declares_key "$envex" "$key" || continue
    if [[ "$(read_val "$dev_env" "$key")" != "$INTERNAL_SECRET" ]]; then
      echo "  ✗ DRIFT: ${dev_env##*/services/} · $key ≠ secreto compartido"
      drift=1
    fi
  done
done
if [[ "$drift" -ne 0 ]]; then
  echo "✗ rail interno INCONSISTENTE entre servicios → 401 silencioso. Abortando el boot." >&2
  exit 1
fi

echo "Listo. Rail interno consistente en $internal_consumers consumidores."
