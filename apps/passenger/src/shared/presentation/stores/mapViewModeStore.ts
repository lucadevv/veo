import {create} from 'zustand';
import {prefsStore} from '../../../core/storage/mmkv';

/**
 * MODO DE VISTA del mapa (toggle 2D/3D del pasajero, pedido del dueño):
 *  - `'3d'` (default = comportamiento actual): edificios con volumen (fill-extrusion del estilo) +
 *    pitch del follow "como si manejara" en el viaje en curso.
 *  - `'2d'`: pitch 0 SIEMPRE (el course-up sigue rotando el bearing, pero plano) + capa `building-3d`
 *    oculta (variante 2D del estilo).
 *
 * Es una PREFERENCIA del usuario → persiste en MMKV (prefs, no sensible) y sobrevive relanzamientos.
 * Vive en un store (no en un useState del mapa) porque la leen DOS piezas desacopladas: el `AppMap`
 * (estilo + pitch) y el botón flotante del flujo (toggle), y el mapa se desmonta al perder foco.
 */
export type MapViewMode = '2d' | '3d';

const STORAGE_KEY = 'map.viewMode';
/** Default 3D = el comportamiento vigente antes del toggle (nadie pierde nada al actualizar). */
const DEFAULT_MODE: MapViewMode = '3d';

/** Lee la preferencia persistida; valor corrupto/ausente → default (jamás rompe el arranque). */
function readPersistedMode(): MapViewMode {
  const raw = prefsStore.getString(STORAGE_KEY);
  return raw === '2d' || raw === '3d' ? raw : DEFAULT_MODE;
}

export interface MapViewModeState {
  mode: MapViewMode;
  /** Alterna 2D ↔ 3D y persiste la elección en MMKV en el acto. */
  toggle: () => void;
}

export const useMapViewModeStore = create<MapViewModeState>(set => ({
  mode: readPersistedMode(),
  toggle: () =>
    set(state => {
      const next: MapViewMode = state.mode === '3d' ? '2d' : '3d';
      prefsStore.setString(STORAGE_KEY, next);
      return {mode: next};
    }),
}));
