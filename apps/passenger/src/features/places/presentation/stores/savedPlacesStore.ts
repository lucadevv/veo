import {create} from 'zustand';
import {TOKENS} from '../../../../core/di/tokens';
import {container} from '../../../../core/di';
import type {SavedPlace, SavedPlaceInput} from '../../domain/entities';

/**
 * Estado reactivo de los Lugares guardados (Zustand) respaldado por el repositorio LOCAL (MMKV).
 * La fuente de verdad es el repo; el store mantiene una copia en memoria para que tanto la pantalla
 * de gestión como los accesos rápidos del buscador re-rendericen al instante tras un CRUD.
 *
 * Resuelve los casos de uso por el contenedor (DIP): no conoce la implementación concreta del repo.
 */
interface SavedPlacesState {
  places: SavedPlace[];
  /**
   * Hidratación de fondo en vuelo SIN caché que mostrar (loading honesto): distingue "todavía
   * cargando" de "no hay lugares". Con caché presente NUNCA es loading (se muestra lo cacheado).
   */
  loading: boolean;
  /**
   * La hidratación de fondo (GET /places) falló Y no hay caché → la lista quedaría muda. Distingue
   * "red caída sin datos" (error + reintento) de "sin lugares guardados" (vacío legítimo). Lo
   * dispara el hook `onLoadError` del repo HTTP (que solo lo emite cuando el caché está vacío).
   */
  loadError: boolean;
  /** Recarga desde el repositorio (limpia loading/error: hay verdad fresca del caché). */
  refresh: () => void;
  /** Reintenta la hidratación tras un error de carga (limpia el error y vuelve a pedir al servidor). */
  retry: () => void;
  save: (input: SavedPlaceInput) => void;
  update: (id: string, input: SavedPlaceInput) => void;
  remove: (id: string) => void;
}

const list = () => container.resolve(TOKENS.listPlacesUseCase);
const saver = () => container.resolve(TOKENS.savePlaceUseCase);
const updater = () => container.resolve(TOKENS.updatePlaceUseCase);
const remover = () => container.resolve(TOKENS.removePlaceUseCase);

export const useSavedPlacesStore = create<SavedPlacesState>(set => {
  // `list()` sirve el caché YA (síncrono) y dispara un GET de fondo (read-through). Sin nada cacheado
  // al arrancar, esa hidratación está en vuelo → loading honesto hasta que un hook la resuelva.
  const initial = list().execute();
  return {
    places: initial,
    loading: initial.length === 0,
    loadError: false,
    refresh: () => set({places: list().execute(), loading: false, loadError: false}),
    retry: () =>
      set(() => {
        // Vuelve a disparar la hidratación (list() re-hace el GET de fondo). Sin caché es loading
        // honesto (no un vacío que miente); con caché se sigue mostrando. El resultado del GET lo
        // resuelven los hooks del repo (onCacheUpdated → refresh / onLoadError → loadError).
        const places = list().execute();
        return {places, loading: places.length === 0, loadError: false};
      }),
    save: input => {
      saver().execute(input);
      set({places: list().execute(), loading: false, loadError: false});
    },
    update: (id, input) => {
      updater().execute(id, input);
      set({places: list().execute(), loading: false, loadError: false});
    },
    remove: id => {
      remover().execute(id);
      set({places: list().execute(), loading: false, loadError: false});
    },
  };
});
