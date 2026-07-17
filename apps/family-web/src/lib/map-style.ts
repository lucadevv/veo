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

  // Un style.json define su propio look (idealmente el veo-light self-hosted, alineado al
  // "Daylight Trust" de las apps): se usa tal cual, sin paint nuestro encima.
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
        // Atenúa el OSM crudo para el lienzo CLARO Trust: el tile queda claro (coherente con el
        // fondo --bg #F5F7FA) pero desaturado, para que la ruta teal #0075A9 + markers sean el
        // único color protagonista (estrategia Restrained: el tile no compite). Mismo criterio
        // que el "Daylight Trust" de las apps RN, aplicado al fallback raster.
        // - saturation -0.6: apaga verdes/amarillos del OSM sin dejarlo gris muerto.
        // - contrast -0.08: suaviza el ruido de calles/manzanas para un fondo calmo.
        // - brightness-min 0.04: levanta apenas los negros del tile (labels/bordes) hacia el
        //   gris-azulado de la identidad; el texto sigue legible.
        // NOTA DE INFRA (no implementar acá): el IDEAL a largo plazo es servir un style.json
        // veo-light self-hosted desde el tileserver (NEXT_PUBLIC_TILE_URL=.../styles/veo-light/
        // style.json, ver env/example.env). Este paint es la mejora del FALLBACK raster XYZ
        // mientras ese style no esté configurado; cuando lo esté, la rama .json lo toma sin paint.
        paint: {
          'raster-brightness-max': 1,
          'raster-brightness-min': 0.04,
          'raster-saturation': -0.6,
          'raster-contrast': -0.08,
        },
      },
    ],
  } satisfies StyleSpecification;
}
