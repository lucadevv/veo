#!/usr/bin/env bash
#
# bootstrap.sh · Setup de MÁQUINA LIMPIA para el monorepo VEO (macOS).
# ─────────────────────────────────────────────────────────────────────────────
# Objetivo: de `git clone` a `./dev-stack/veo.sh dev` con 20/20 servicios arriba,
# sin cazar dependencias a mano. Idempotente: lo ya instalado se saltea.
#
#   ./bootstrap.sh          # chequea e instala toolchain + scaffolding
#   ./bootstrap.sh --check  # SOLO diagnóstico, no instala nada
#
# Qué cubre (aprendido en la migración de máquina 2026-07-03):
#   1) toolchain: brew, fnm+node (.nvmrc), corepack/pnpm, go, python3.12, gh, rg
#   2) docker: colima con --vm-type vz --vz-rosetta (¡postgis es amd64-only:
#      sin rosetta segfaultea con Exited 139 sin logs!)
#   3) deps: pnpm install
#   4) biometric: venv python3.12 + requirements (si pip deja el venv a medias
#      —uvicorn sin binario— recrearlo de cero)
#   5) secretos/envs: los GENERABLES los crea veo.sh al bootear; acá se reporta
#      qué falta traer A MANO (terceros: FCM, APNs, Mapbox, ProntoPaga, OAuth,
#      modelos ONNX) — típicamente desde dev-stack/secrets/ de otra máquina.
#   6) MCPs: el .mcp.json del repo los carga al abrir el proyecto; acá se
#      verifica que sus BINARIOS existan (app Pencil, mjolnir).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

CHECK_ONLY=0; [[ "${1:-}" == "--check" ]] && CHECK_ONLY=1
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ok()   { printf '  \033[32m✅ %s\033[0m\n' "$*"; }
warn() { printf '  \033[33m⚠️  %s\033[0m\n' "$*"; }
fail() { printf '  \033[31m❌ %s\033[0m\n' "$*"; }
hdr()  { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
MISSING=()

# ── 1. Toolchain ──────────────────────────────────────────────────────────────
hdr "TOOLCHAIN"
if ! command -v brew >/dev/null 2>&1; then
  fail "homebrew — instalalo primero: https://brew.sh"; exit 1
fi
ok "brew"

for pkg in fnm go python@3.12 gh ripgrep; do
  case "$pkg" in python@3.12) bin=python3.12 ;; ripgrep) bin=rg ;; *) bin="$pkg" ;; esac
  # command -v no ve alias de zsh ni PATH custom → probamos también las rutas típicas de brew/cargo.
  if command -v "$bin" >/dev/null 2>&1 || [[ -x "/opt/homebrew/bin/$bin" ]] || [[ -x "$HOME/.cargo/bin/$bin" ]]; then
    ok "$pkg"
  elif (( CHECK_ONLY )); then
    fail "$pkg"; MISSING+=("brew install $pkg")
  else
    echo "  instalando $pkg…"; brew install "$pkg" >/dev/null 2>&1 && ok "$pkg instalado" || fail "$pkg"
  fi
done

# fnm en el shell + node del .nvmrc
if ! grep -q "fnm env" ~/.zshrc 2>/dev/null; then
  (( CHECK_ONLY )) || printf '\n# fnm (Node) — auto-switch por .nvmrc\neval "$(fnm env --use-on-cd --shell zsh)"\n' >> ~/.zshrc
  warn "fnm agregado a ~/.zshrc — abrí una terminal nueva después"
fi
eval "$(fnm env --shell bash)" 2>/dev/null || true
NODE_WANT="$(cat "$ROOT/.nvmrc")"
if fnm list 2>/dev/null | grep -q "$NODE_WANT"; then ok "node $NODE_WANT"
elif (( CHECK_ONLY )); then fail "node $NODE_WANT"; MISSING+=("fnm install $NODE_WANT")
else fnm install "$NODE_WANT" && fnm default "$NODE_WANT" && ok "node $NODE_WANT instalado"; fi
fnm use "$NODE_WANT" 2>/dev/null || true

# pnpm vía corepack (versión pinneada en package.json → packageManager)
corepack enable >/dev/null 2>&1 || true
command -v pnpm >/dev/null 2>&1 && ok "pnpm $(pnpm --version 2>/dev/null)" || { fail "pnpm"; MISSING+=("corepack enable"); }

# docker compose plugin (el docker de colima no lo trae)
if docker compose version >/dev/null 2>&1; then ok "docker compose"
elif (( CHECK_ONLY )); then fail "docker compose plugin"; MISSING+=("brew install docker-compose + link en ~/.docker/cli-plugins")
else
  brew install docker-compose >/dev/null 2>&1
  mkdir -p ~/.docker/cli-plugins
  ln -sf "$(brew --prefix)/opt/docker-compose/bin/docker-compose" ~/.docker/cli-plugins/docker-compose
  docker compose version >/dev/null 2>&1 && ok "docker compose instalado" || fail "docker compose"
fi

# ── 2. Docker / Colima con ROSETTA (crítico para postgis amd64) ───────────────
hdr "DOCKER (colima + rosetta)"
if command -v colima >/dev/null 2>&1; then
  if colima status >/dev/null 2>&1; then
    ok "colima corriendo"
    warn "verificá que el perfil tenga rosetta: si postgres muere con 'Exited (139)', corré:"
    echo "      colima stop && colima start --cpu 4 --memory 8 --vm-type vz --vz-rosetta"
  elif (( CHECK_ONLY )); then fail "colima detenido"; MISSING+=("colima start --cpu 4 --memory 8 --vm-type vz --vz-rosetta")
  else colima start --cpu 4 --memory 8 --vm-type vz --vz-rosetta && ok "colima arrancado con rosetta"; fi
else
  fail "colima"; MISSING+=("brew install colima && colima start --cpu 4 --memory 8 --vm-type vz --vz-rosetta")
fi

# ── 3. Dependencias del monorepo ──────────────────────────────────────────────
hdr "DEPENDENCIAS"
if [[ -d "$ROOT/node_modules" ]]; then ok "node_modules presente"
elif (( CHECK_ONLY )); then fail "falta pnpm install"; MISSING+=("pnpm install")
else (cd "$ROOT" && pnpm install) && ok "pnpm install OK"; fi

# ── 4. biometric-service (python 3.12 + venv) ─────────────────────────────────
hdr "BIOMETRIC (python)"
BIO="$ROOT/services/biometric-service"
if [[ -x "$BIO/.venv/bin/uvicorn" ]]; then ok "venv + uvicorn"
elif (( CHECK_ONLY )); then fail "venv de biometric"; MISSING+=("cd services/biometric-service && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt")
else
  ( cd "$BIO" && rm -rf .venv && /opt/homebrew/bin/python3.12 -m venv .venv \
    && .venv/bin/pip install --quiet --upgrade pip \
    && .venv/bin/pip install --quiet -r requirements.txt )
  [[ -x "$BIO/.venv/bin/uvicorn" ]] && ok "venv creado" || fail "venv (revisá pip; si quedó a medias: rm -rf .venv y reintentá)"
fi
if ls "$BIO/models/"*.onnx >/dev/null 2>&1; then ok "modelos ONNX ($(ls "$BIO/models/"*.onnx | wc -l | tr -d ' '))"
else warn "faltan modelos ONNX (det_10g, w600k_r50, minifasnet_v2) → copialos a services/biometric-service/models/ (biometric bootea sin ellos, pero no infiere)"; fi

# ── 5. Secretos / envs — reporte HONESTO de lo que falta traer a mano ─────────
hdr "SECRETOS / ENVS"
echo "  Los generables (JWT, HMACs, salts) los crea ./dev-stack/veo.sh al bootear."
n_env=$(find "$ROOT/services" -path "*/env/development.env" 2>/dev/null | wc -l | tr -d ' ')
if (( n_env > 10 )); then ok "envs de desarrollo presentes ($n_env servicios)"
else warn "solo $n_env development.env — el resto los genera veo.sh, pero los de TERCEROS se traen a mano:"; fi
for f in fcm-service-account.json apns-key.p8 mapbox-access-token.txt prontopaga-api-token.txt; do
  [[ -f "$ROOT/dev-stack/secrets/$f" ]] && ok "secrets/$f" || warn "falta dev-stack/secrets/$f (traelo de la bóveda/otra máquina)"
done
[[ -d "$ROOT/dev-stack/secrets/mobile" ]] && ok "secrets/mobile (google-services, GoogleService-Info, AuthKey APNs)" \
  || warn "falta dev-stack/secrets/mobile/ (configs firebase/APNs de las apps móviles)"

# ── 6. MCPs (el .mcp.json del repo los carga al abrir; acá van los binarios) ──
hdr "MCPs (pencil + mjolnir)"
if [[ -x "/Applications/Pencil.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-arm64" ]]; then
  ok "Pencil.app (MCP incluido) — abrila y cargá design/veo.pen antes de diseñar"
else
  warn "falta Pencil.app → descargá https://www.pencil.dev/download/Pencil-mac-arm64.dmg y arrastrá a /Applications"
fi
if command -v mjolnir >/dev/null 2>&1 || [[ -x "$HOME/.local/bin/mjolnir" ]]; then
  ok "mjolnir — indexá con: mjolnir index ."
else
  warn "falta mjolnir → gh auth login && curl -fsSL https://raw.githubusercontent.com/lucadevv/mjolnir/main/bootstrap.sh | bash"
fi

# ── Cierre ────────────────────────────────────────────────────────────────────
hdr "RESUMEN"
if (( ${#MISSING[@]} )); then
  echo "  Pendientes (corré estos comandos):"
  printf '    %s\n' "${MISSING[@]}"
else
  echo "  Todo listo. Siguiente paso:"
  echo "    ./dev-stack/veo.sh dev     # ignición completa en watch + tablero"
fi
