import { create } from 'zustand';
import { TOKENS } from '../../../../core/di/tokens';
import { container } from '../../../../core/di';
import type { SavedPlace, SavedPlaceInput } from '../../domain/entities';

/**
 * Estado reactivo de los Lugares guardados (Zustand) respaldado por el repositorio LOCAL (MMKV).
 * La fuente de verdad es el repo; el store mantiene una copia en memoria para que tanto la pantalla
 * de gestión como los accesos rápidos del buscador re-rendericen al instante tras un CRUD.
 *
 * Resuelve los casos de uso por el contenedor (DIP): no conoce la implementación concreta del repo.
 */
interface SavedPlacesState {
  places: SavedPlace[];
  /** Recarga desde el repositorio. */
  refresh: () => void;
  save: (input: SavedPlaceInput) => void;
  update: (id: string, input: SavedPlaceInput) => void;
  remove: (id: string) => void;
}

const list = () => container.resolve(TOKENS.listPlacesUseCase);
const saver = () => container.resolve(TOKENS.savePlaceUseCase);
const updater = () => container.resolve(TOKENS.updatePlaceUseCase);
const remover = () => container.resolve(TOKENS.removePlaceUseCase);

export const useSavedPlacesStore = create<SavedPlacesState>((set) => ({
  places: list().execute(),
  refresh: () => set({ places: list().execute() }),
  save: (input) => {
    saver().execute(input);
    set({ places: list().execute() });
  },
  update: (id, input) => {
    updater().execute(id, input);
    set({ places: list().execute() });
  },
  remove: (id) => {
    remover().execute(id);
    set({ places: list().execute() });
  },
}));
