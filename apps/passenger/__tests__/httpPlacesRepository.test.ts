import {ApiError, type HttpClient} from '@veo/api-client';
import type {KeyValueStore} from '../src/core/storage/mmkv';
import {
  HttpSavedPlacesRepository,
  PlacesFavoritesLimitError,
} from '../src/features/places/data/httpPlacesRepository';
import type {SavedPlaceInput} from '../src/features/places/domain/entities';

/** KeyValueStore en memoria (sin MMKV nativo). */
class MemoryStore implements KeyValueStore {
  private map = new Map<string, string>();
  getString(k: string) {
    return this.map.get(k);
  }
  setString(k: string, v: string) {
    this.map.set(k, v);
  }
  getJSON<T>(k: string): T | undefined {
    const raw = this.map.get(k);
    return raw ? (JSON.parse(raw) as T) : undefined;
  }
  setJSON<T>(k: string, v: T) {
    this.map.set(k, JSON.stringify(v));
  }
  getBoolean() {
    return undefined;
  }
  setBoolean() {
    /* no-op */
  }
  has(k: string) {
    return this.map.has(k);
  }
  remove(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

const lima: SavedPlaceInput['point'] = {lat: -12.04, lng: -77.04};
const flush = () => new Promise(r => setImmediate(r));

/** Fake mínimo del HttpClient con las cuatro verbos que usa el repo. */
function fakeHttp(overrides: Partial<HttpClient>): HttpClient {
  return {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
    ...overrides,
  } as unknown as HttpClient;
}

describe('HttpSavedPlacesRepository', () => {
  it('list() sirve el caché de forma SÍNCRONA y rehidrata mapeando lat/lng → point', async () => {
    const onCacheUpdated = jest.fn();
    const http = fakeHttp({
      get: jest.fn(async () => [
        {
          id: 'p1',
          kind: 'HOME',
          label: 'Casa',
          subtitle: null,
          lat: -12.04,
          lng: -77.04,
          createdAt: '2026-05-30T00:00:00.000Z',
        },
      ]),
    });
    const repo = new HttpSavedPlacesRepository(http, new MemoryStore(), {
      onCacheUpdated,
    });

    // Primera lectura: caché vacío (la red aún no respondió) → no bloquea.
    expect(repo.list()).toEqual([]);
    await flush();

    // Tras hidratar, el caché tiene el lugar con el mapeo BFF→dominio (point anidado).
    expect(onCacheUpdated).toHaveBeenCalled();
    const list = repo.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 'p1',
      kind: 'HOME',
      point: {lat: -12.04, lng: -77.04},
    });
    expect(list[0]).not.toHaveProperty('lat');
  });

  it('save() aplica optimista y, al éxito, reemplaza por el recurso REAL del servidor (mapea point→lat/lng)', async () => {
    const post = jest.fn(async () => ({
      id: 'server-id',
      kind: 'FAVORITE',
      label: 'Gimnasio',
      subtitle: 'Av. Larco 123',
      lat: -12.04,
      lng: -77.04,
      createdAt: '2026-05-30T00:00:00.000Z',
    }));
    const repo = new HttpSavedPlacesRepository(
      fakeHttp({post}),
      new MemoryStore(),
    );

    const optimistic = repo.save({
      kind: 'FAVORITE',
      label: 'Gimnasio',
      subtitle: 'Av. Larco 123',
      point: lima,
    });
    // Optimista: visible al instante con un id provisional.
    expect(repo.list()[0]!.label).toBe('Gimnasio');
    await flush();

    // El body enviado lleva lat/lng planos (no point).
    expect(post).toHaveBeenCalledWith(
      '/places',
      expect.objectContaining({
        body: expect.objectContaining({
          lat: -12.04,
          lng: -77.04,
          kind: 'FAVORITE',
        }),
      }),
    );
    // El optimista fue reemplazado por el id real del servidor.
    const after = repo.list();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe('server-id');
    expect(after[0]!.id).not.toBe(optimistic.id);
  });

  it('save() con 409 (tope favoritos) revierte el optimista y reporta PlacesFavoritesLimitError', async () => {
    const onReconcileError = jest.fn();
    const post = jest.fn(async () => {
      throw new ApiError(409, 'RESOURCE_EXHAUSTED', 'máximo de favoritos');
    });
    const repo = new HttpSavedPlacesRepository(
      fakeHttp({post}),
      new MemoryStore(),
      {
        onReconcileError,
      },
    );

    repo.save({kind: 'FAVORITE', label: 'Uno más', point: lima});
    expect(repo.list()).toHaveLength(1); // optimista presente
    await flush();

    expect(repo.list()).toHaveLength(0); // revertido
    expect(onReconcileError).toHaveBeenCalledWith(
      expect.any(PlacesFavoritesLimitError),
    );
  });

  it('save() con error de red TRANSITORIO conserva el optimista (degradación offline)', async () => {
    const onReconcileError = jest.fn();
    const post = jest.fn(async () => {
      throw new ApiError(0, 'NETWORK_ERROR', 'sin red');
    });
    const repo = new HttpSavedPlacesRepository(
      fakeHttp({post}),
      new MemoryStore(),
      {
        onReconcileError,
      },
    );

    repo.save({kind: 'HOME', label: 'Casa', point: lima});
    await flush();

    expect(repo.list()).toHaveLength(1); // se conserva para sincronizar luego
    expect(onReconcileError).not.toHaveBeenCalled();
  });

  it('remove() borra optimista y, si el DELETE falla NO transitorio, restaura el caché', async () => {
    const onReconcileError = jest.fn();
    const del = jest.fn(async () => {
      throw new ApiError(404, 'NOT_FOUND', 'no existe');
    });
    const store = new MemoryStore();
    store.setJSON('places.http.cache', [
      {
        id: 'x',
        kind: 'FAVORITE',
        label: 'Gym',
        point: lima,
        createdAt: '2026-05-30T00:00:00.000Z',
      },
    ]);
    const repo = new HttpSavedPlacesRepository(fakeHttp({delete: del}), store, {
      onReconcileError,
    });

    repo.remove('x');
    expect(repo.list()).toHaveLength(0); // optimista
    await flush();

    expect(repo.list()).toHaveLength(1); // restaurado al fallar el DELETE
    expect(onReconcileError).toHaveBeenCalled();
  });
});
