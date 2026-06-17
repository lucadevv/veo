import type {MapPoint} from '@veo/api-client';

/**
 * Entidades de dominio de Lugares guardados (feature 100% LOCAL, sin backend). El pasajero guarda
 * sus sitios frecuentes (Casa, Trabajo y favoritos con etiqueta) para fijar destino con un toque.
 */

/** Tipo de lugar. `HOME`/`WORK` son únicos; `FAVORITE` admite varios con etiqueta libre. */
export type SavedPlaceKind = 'HOME' | 'WORK' | 'FAVORITE';

/** Un lugar guardado: punto geográfico (formato de la API de mapas, lng) + etiqueta legible. */
export interface SavedPlace {
  id: string;
  kind: SavedPlaceKind;
  /** Etiqueta mostrada (Casa/Trabajo o el nombre del favorito). */
  label: string;
  /** Dirección/subtítulo legible (opcional). */
  subtitle?: string;
  point: MapPoint;
  /** Marca de tiempo de creación (ISO) para ordenar favoritos. */
  createdAt: string;
}

/** Datos para crear/editar un lugar (sin id ni createdAt, los pone el repo). */
export interface SavedPlaceInput {
  kind: SavedPlaceKind;
  label: string;
  subtitle?: string;
  point: MapPoint;
}

/** Longitud máxima de la etiqueta de un favorito (evita overflow en la UI). */
export const MAX_PLACE_LABEL_LENGTH = 40;
