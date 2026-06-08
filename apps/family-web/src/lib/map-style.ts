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
      },
    ],
  } satisfies StyleSpecification;
}
