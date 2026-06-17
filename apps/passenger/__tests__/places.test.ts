import type {KeyValueStore} from '../src/core/storage/mmkv';
import {LocalPlacesRepository} from '../src/features/places/data/localPlacesRepository';
import type {SavedPlaceInput} from '../src/features/places/domain/entities';
import {
  PlaceValidationError,
  SavePlaceUseCase,
} from '../src/features/places/domain/usecases';

/** KeyValueStore en memoria para tests (sin MMKV nativo). */
class MemoryStore implements KeyValueStore {
  private map = new Map<string, string>();
  getString(key: string) {
    return this.map.get(key);
  }
  setString(key: string, value: string) {
    this.map.set(key, value);
  }
  getJSON<T>(key: string): T | undefined {
    const raw = this.map.get(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  }
  setJSON<T>(key: string, value: T) {
    this.map.set(key, JSON.stringify(value));
  }
  getBoolean() {
    return undefined;
  }
  setBoolean() {
    /* no-op */
  }
  has(key: string) {
    return this.map.has(key);
  }
  remove(key: string) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}

const lima: SavedPlaceInput['point'] = {lat: -12.04, lng: -77.04};

/** Reloj incremental determinista para ordenar por createdAt. */
function clock() {
  let tick = 0;
  return () => `2026-05-30T00:00:${String(tick++).padStart(2, '0')}.000Z`;
}

describe('LocalPlacesRepository', () => {
  it('mantiene Casa y Trabajo únicos (reemplaza el previo del mismo tipo)', () => {
    const repo = new LocalPlacesRepository(new MemoryStore(), clock());

    repo.save({kind: 'HOME', label: 'Casa', point: lima});
    repo.save({
      kind: 'HOME',
      label: 'Casa nueva',
      point: {lat: -12.05, lng: -77.05},
    });

    const homes = repo.list().filter(p => p.kind === 'HOME');
    expect(homes).toHaveLength(1);
    expect(homes[0]!.label).toBe('Casa nueva');
  });

  it('agrega varios favoritos y los ordena (Casa/Trabajo primero, favoritos por fecha desc)', () => {
    const repo = new LocalPlacesRepository(new MemoryStore(), clock());

    repo.save({kind: 'FAVORITE', label: 'Gimnasio', point: lima});
    repo.save({kind: 'WORK', label: 'Trabajo', point: lima});
    repo.save({kind: 'FAVORITE', label: 'Casa de mamá', point: lima});
    repo.save({kind: 'HOME', label: 'Casa', point: lima});

    const list = repo.list();
    expect(list.map(p => p.kind)).toEqual([
      'HOME',
      'WORK',
      'FAVORITE',
      'FAVORITE',
    ]);
    // El favorito más reciente va primero entre los favoritos.
    const favs = list.filter(p => p.kind === 'FAVORITE');
    expect(favs[0]!.label).toBe('Casa de mamá');
  });

  it('edita y elimina por id', () => {
    const repo = new LocalPlacesRepository(new MemoryStore(), clock());

    const fav = repo.save({kind: 'FAVORITE', label: 'Gimnasio', point: lima});
    repo.update(fav.id, {kind: 'FAVORITE', label: 'Gym nuevo', point: lima});
    expect(repo.list()[0]!.label).toBe('Gym nuevo');

    repo.remove(fav.id);
    expect(repo.list()).toHaveLength(0);
  });
});

describe('SavePlaceUseCase', () => {
  it('rechaza etiqueta vacía en un favorito', () => {
    const repo = new LocalPlacesRepository(new MemoryStore(), clock());
    const useCase = new SavePlaceUseCase(repo);

    expect(() =>
      useCase.execute({kind: 'FAVORITE', label: '   ', point: lima}),
    ).toThrow(PlaceValidationError);
  });

  it('rellena la etiqueta por defecto de Casa/Trabajo y valida el punto', () => {
    const repo = new LocalPlacesRepository(new MemoryStore(), clock());
    const useCase = new SavePlaceUseCase(repo);

    const home = useCase.execute({kind: 'HOME', label: '', point: lima});
    expect(home.label).toBe('Casa');

    expect(() =>
      useCase.execute({
        kind: 'HOME',
        label: '',
        point: {lat: Number.NaN, lng: 0},
      }),
    ).toThrow(PlaceValidationError);
  });
});
