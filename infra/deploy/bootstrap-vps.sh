#!/usr/bin/env bash
# bootstrap-vps.sh — provisión ONE-TIME de un VPS fresco para correr VEO (Docker Compose, self-hosted).
#
# Qué hace (idempotente — re-correrlo es seguro):
#   1. Crea la red Docker `veo-net` (el compose la marca `external: true`; sin esto, `up` falla).
#   2. Valida que /opt/veo/.env exista y tenga los secretos de infra requeridos (fail-fast con el contrato).
#   3. Levanta MinIO y crea los buckets de objetos (avatars con descarga anónima en avatars/, resto privados).
#
# Lo que NO hace (a propósito): no instala Docker (hacelo antes), no clona el repo, no setea los secretos
# de GitHub Actions (eso va en el dashboard de GitHub — ver docs/runbooks/deploy-vps.md), no arranca los
# servicios de app (eso lo dispara el job `deploy` de .github/workflows/images.yml tras el push a main).
#
# Uso (en el VPS, parado en /opt/veo):
#   bash infra/deploy/bootstrap-vps.sh
#
# Pre-requisitos: Docker + Docker Compose instalados; el repo clonado en /opt/veo; /opt/veo/.env creado
# desde infra/deploy/vps.env.example con valores reales.
set -euo pipefail

# --- config (override por env si hace falta) ---
VEO_DIR="${VEO_DIR:-/opt/veo}"
VEO_NET="${VEO_NET:-veo-net}"
COMPOSE="${COMPOSE:-docker-compose.preview.yml}"
ENV_FILE="${VEO_DIR}/.env"
# Buckets MinIO. El primero (avatars) recibe descarga ANÓNIMA en el prefijo avatars/ (publicUrl estable
# de avatar sin firma); el resto quedan privados. Ajustá los nombres para que matcheen S3_BUCKET_* de los
# preview.env de tus servicios (media/fleet/panic/audit).
VEO_AVATARS_BUCKET="${VEO_AVATARS_BUCKET:-veo-avatars}"
# Buckets PRIVADOS con PII/video sensible → se cifran at-rest con SSE-S3 (Ley 29733 · §0.7c). Incluye
# veo-video (grabación de cabina, el dato más sensible) que antes no se aprovisionaba acá.
VEO_PRIVATE_BUCKETS="${VEO_PRIVATE_BUCKETS:-veo-video veo-documents veo-panic-evidence veo-audit}"
# Secretos de infra que el compose exige (${VAR:?}). Deben existir y NO estar vacíos en /opt/veo/.env.
# MINIO_KMS_SECRET_KEY = clave maestra del cifrado at-rest soberano (SOPS+age), formato nombre:base64(32B).
REQUIRED_VARS=(CLICKHOUSE_PASSWORD MINIO_ROOT_PASSWORD MINIO_KMS_SECRET_KEY LIVEKIT_API_SECRET CLOUDFLARE_TUNNEL_TOKEN)

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
blue()  { printf '\033[36m%s\033[0m\n' "$*"; }
die()   { red "✗ $*"; exit 1; }

[ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ] && { sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

blue "== bootstrap-vps :: provisión one-time de VEO en ${VEO_DIR} =="

# --- 0) pre-flight ---
command -v docker >/dev/null || die "Docker no está instalado. Instalalo antes (https://docs.docker.com/engine/install/)."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 no disponible (docker compose ...)."
[ -f "${VEO_DIR}/${COMPOSE}" ] || die "No encuentro ${VEO_DIR}/${COMPOSE}. ¿Clonaste el repo en ${VEO_DIR}?"

# --- 1) red veo-net (idempotente) ---
if docker network inspect "${VEO_NET}" >/dev/null 2>&1; then
  green "✓ red ${VEO_NET} ya existe"
else
  docker network create "${VEO_NET}" >/dev/null && green "✓ red ${VEO_NET} creada"
fi

# --- 2) validar /opt/veo/.env (fail-fast con el contrato) ---
[ -f "${ENV_FILE}" ] || die "Falta ${ENV_FILE}. Copialo de infra/deploy/vps.env.example y rellená los valores reales."
missing=()
for v in "${REQUIRED_VARS[@]}"; do
  val="$(grep -E "^${v}=" "${ENV_FILE}" | head -1 | cut -d= -f2-)"
  [ -n "${val}" ] || missing+=("${v}")
done
[ ${#missing[@]} -eq 0 ] || die "${ENV_FILE} no define (o deja vacío): ${missing[*]}. Ver infra/deploy/vps.env.example."
green "✓ ${ENV_FILE} tiene los ${#REQUIRED_VARS[@]} secretos de infra requeridos"

# --- 3) MinIO + buckets ---
cd "${VEO_DIR}"
blue "-- levantando MinIO para aprovisionar buckets --"
docker compose --env-file "${ENV_FILE}" -f "${COMPOSE}" up -d minio
# esperar a que MinIO responda
for i in $(seq 1 30); do
  docker compose --env-file "${ENV_FILE}" -f "${COMPOSE}" exec -T minio mc --version >/dev/null 2>&1 && break
  [ "$i" = "30" ] && die "MinIO no respondió tras 30 intentos."
  sleep 2
done
# crear buckets vía un contenedor mc efímero en la misma red (lee credenciales del .env)
set -a
# shellcheck disable=SC1090  # el path del .env es runtime, no constante — intencional
. "${ENV_FILE}"
set +a
MC="docker run --rm --network ${VEO_NET} -e MC_HOST_local=http://${MINIO_ROOT_USER:-veo}:${MINIO_ROOT_PASSWORD}@minio:9000 minio/mc:latest"
${MC} mb --ignore-existing "local/${VEO_AVATARS_BUCKET}" >/dev/null && green "✓ bucket ${VEO_AVATARS_BUCKET} (avatars)"
${MC} anonymous set download "local/${VEO_AVATARS_BUCKET}/avatars" >/dev/null && green "✓ descarga anónima en ${VEO_AVATARS_BUCKET}/avatars"
for b in ${VEO_PRIVATE_BUCKETS}; do
  ${MC} mb --ignore-existing "local/${b}" >/dev/null && green "✓ bucket ${b} (privado)"
  # Cifrado at-rest SOBERANO (Ley 29733 · §0.7c): auto-encryption SSE-S3 con la clave maestra propia
  # (MINIO_KMS_SECRET_KEY). Envelope real: cada objeto con su data-key envuelta por la maestra. Transparente
  # (LiveKit egress y las URLs prefirmadas no cambian). Idempotente. El object-lock del WORM (veo-audit)
  # coexiste con SSE-S3.
  ${MC} encrypt set sse-s3 "local/${b}" >/dev/null && green "  ↳ SSE-S3 at-rest activado en ${b}"
done

green "== bootstrap completo. Próximo paso: activar el deploy en GitHub (ver docs/runbooks/deploy-vps.md) =="
