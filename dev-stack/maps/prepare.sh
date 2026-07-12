#!/usr/bin/env bash
# =============================================================
# VEO · Aprovisionamiento de datos OSM soberanos (tiles + ruteo + geocoding)
# Genera todo desde un extracto OSM, sin servicios de terceros.
# Uso:  ./prepare.sh        (región por defecto: peru)
#       REGION_URL=... ./prepare.sh
# =============================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

REGION_URL="${REGION_URL:-https://download.geofabrik.de/south-america/peru-latest.osm.pbf}"
PBF="region.osm.pbf"
OSRM_PROFILE="${OSRM_PROFILE:-/opt/car.lua}"

mkdir -p tiles osrm nominatim/data

echo "==> 1/4 Descargando extracto OSM: $REGION_URL"
if [ ! -f "$PBF" ]; then
  if command -v wget >/dev/null 2>&1; then wget -O "$PBF" "$REGION_URL"; else curl -L -o "$PBF" "$REGION_URL"; fi
else
  echo "    $PBF ya existe, se reutiliza."
fi

echo "==> 2/4 Generando tiles vectoriales (Planetiler) → tiles/region.mbtiles"
if [ ! -f "tiles/region.mbtiles" ]; then
  docker run --rm -v "$HERE:/work" -w /work ghcr.io/onthegomap/planetiler:latest \
    --download --osm-path="/work/$PBF" --output="/work/tiles/region.mbtiles" --force
fi
# Fonts (glyphs) para el tileserver: el style veo-dark usa "Noto Sans Regular" y el config apunta a
# tiles/fonts. NO vienen del .mbtiles → los extraemos de la imagen tileserver-gl (bundled) una sola vez.
# Sin esto tileserver-gl aborta al boot ("path for fonts does not exist").
if [ ! -d "tiles/fonts" ]; then
  echo "    extrayendo fonts (glyphs) bundled de tileserver-gl → tiles/fonts"
  docker run --rm -v "$HERE/tiles:/out" --entrypoint sh maptiler/tileserver-gl:latest \
    -c 'cp -r /usr/src/app/node_modules/tileserver-gl-styles/fonts /out/fonts'
fi
# El config referencia un dir `sprites` (aunque el style veo-dark no use sprites): tileserver-gl aborta si
# la ruta no existe → un dir vacío satisface el check.
mkdir -p tiles/sprites

cat > tiles/config.json <<'JSON'
{
  "options": {
    "paths": { "root": "/data", "mbtiles": "", "styles": "styles", "fonts": "fonts", "sprites": "sprites" }
  },
  "styles": {
    "veo-dark": { "style": "veo-dark/style.json" }
  },
  "data": { "region": { "mbtiles": "region.mbtiles" } }
}
JSON

echo "==> 3/4 Preprocesando OSRM (perfil car, MLD) → osrm/region.osrm*"
cp -f "$PBF" osrm/region.osm.pbf
# osrm-backend solo publica imagen amd64; en Apple Silicon se emula con --platform.
OSRM_PLATFORM="${OSRM_PLATFORM:---platform linux/amd64}"
docker run --rm -t $OSRM_PLATFORM -v "$HERE/osrm:/data" ghcr.io/project-osrm/osrm-backend:latest \
  osrm-extract -p "$OSRM_PROFILE" /data/region.osm.pbf
docker run --rm -t $OSRM_PLATFORM -v "$HERE/osrm:/data" ghcr.io/project-osrm/osrm-backend:latest \
  osrm-partition /data/region.osrm
docker run --rm -t $OSRM_PLATFORM -v "$HERE/osrm:/data" ghcr.io/project-osrm/osrm-backend:latest \
  osrm-customize /data/region.osrm

echo "==> 4/4 Copiando .pbf para Nominatim (auto-import en primer arranque)"
cp -f "$PBF" nominatim/data/region.osm.pbf

echo "==> Listo. Levanta con:  docker compose --profile maps up -d tileserver osrm nominatim"
