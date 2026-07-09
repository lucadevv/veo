import type { HeatmapQuery } from './entities';

/**
 * Claves de caché COMPARTIDAS del dominio de operaciones (mapa de calor / incentivos). Viven en
 * `domain` (no en `presentation`) para que otras features (turno) lean el MISMO cache con coherencia
 * SIN importar los hooks internos de `ops/presentation` (feature-isolation).
 */

/** Clave de caché del mapa de calor (depende de lat/lng redondeados + radio). */
export const heatmapQueryKey = (query: HeatmapQuery | null) =>
  query
    ? ([
        'ops',
        'heatmap',
        query.lat.toFixed(3),
        query.lng.toFixed(3),
        query.radius ?? 'default',
      ] as const)
    : (['ops', 'heatmap', 'idle'] as const);

/** Clave de caché de incentivos. */
export const INCENTIVES_QUERY_KEY = ['ops', 'incentives'] as const;
