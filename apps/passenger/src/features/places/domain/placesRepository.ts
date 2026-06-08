import type { SavedPlace, SavedPlaceInput } from './entities';

/**
 * Abstracción del repositorio de Lugares guardados (DIP). Persistencia LOCAL (MMKV), sin red.
 * La implementación concreta (`data`) decide el almacenamiento; el dominio solo conoce esta interfaz.
 */
export interface PlacesRepository {
  /** Lista todos los lugares (Casa/Trabajo primero, luego favoritos por fecha desc). */
  list(): SavedPlace[];
  /**
   * Crea o reemplaza un lugar. Para `HOME`/`WORK` (únicos) sustituye el existente; para `FAVORITE`
   * agrega uno nuevo. Devuelve el lugar persistido (con id y createdAt).
   */
  save(input: SavedPlaceInput): SavedPlace;
  /** Actualiza un lugar existente por id (etiqueta/subtítulo/punto). */
  update(id: string, input: SavedPlaceInput): SavedPlace;
  /** Elimina un lugar por id. */
  remove(id: string): void;
}
