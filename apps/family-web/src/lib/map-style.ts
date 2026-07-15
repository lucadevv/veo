import type { StyleSpecification } from 'maplibre-gl';

/** Atribución obligatoria de OpenStreetMap para tiles OSM self-hosted. */
const OSM_ATTRIBUTION = '© OpenStreetMap';

/**
 * Resuelve el estilo de MapLibre desde NEXT_PUBLIC_TILE_URL.
 * - Si apunta a un style.json (vector/raster self-hosted), se usa la URL directamente.
 * - Si es una plantilla XYZ ({z}/{x}/{y}), se construye un estilo raster mínimo.
 * Devuelve null si no hay tiles configurados (el mapa mostrará estado "no disponible").
 */
export function resolveMapStyle(tileUrl: string): string | StyleSpecification | null {
  const trimmed = tileUrl.trim();
  if (!trimmed) return null;

  // Un style.json define su propio look (idealmente un dark self-hosted): se usa tal cual,
  // sin paint nuestro encima.
  if (trimmed.endsWith('.json')) return trimmed;

  return {
    version: 8,
    sources: {
      'osm-tiles': {
        type: 'raster',
        tiles: [trimmed],
        tileSize: 256,
        attribution: OSM_ATTRIBUTION,
      },
    },
    layers: [
      {
        id: 'osm-tiles',
        type: 'raster',
        source: 'osm-tiles',
        minzoom: 0,
        maxzoom: 19,
        // Oscurece y desatura el OSM CLARO para alinearlo con el lienzo near-black azulado de
        // marca y que la ruta azul #2D7FF9 + markers RESALTEN encima. NO es un invert: MapLibre
        // raster no invierte, y un CSS invert sobre el canvas rompería la ruta/markers (se dibujan
        // en el mismo canvas WebGL). El objetivo es un mapa gris-oscuro atenuado, con calles/labels
        // aún legibles. Valores ajustados con criterio de diseño (estrategia Restrained: el azul
        // es el único color protagonista; el tile no compite).
        // - brightness-max 0.45: lleva el blanco del OSM a gris-medio-oscuro sin matar la lectura.
        // - brightness-min 0: hunde texto/bordes oscuros del tile, amplía el rango hacia abajo.
        // - saturation -0.7: desatura verdes/amarillos del OSM para que ningún color rivalice con el azul.
        // - contrast -0.1: suaviza franjas duras blancas para un gris uniforme y atenuado.
        // NOTA DE INFRA (no implementar acá): el dark IDEAL a largo plazo es servir un style.json
        // dark self-hosted desde el tileserver (NEXT_PUBLIC_TILE_URL=.../styles/veo/style.json,
        // ver .env.example). Este paint es la mejora del FALLBACK raster XYZ mientras ese style
        // dark no esté configurado; cuando lo esté, la rama .json de arriba lo toma sin este paint.
        paint: {
          'raster-brightness-max': 0.45,
          'raster-brightness-min': 0,
          'raster-saturation': -0.7,
          'raster-contrast': -0.1,
        },
      },
    ],
  } satisfies StyleSpecification;
}
