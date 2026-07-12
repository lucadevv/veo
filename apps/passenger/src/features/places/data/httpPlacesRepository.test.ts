import {ApiError, type HttpClient} from '@veo/api-client';
import type {ZodType} from 'zod';
import type {KeyValueStore} from '../../../core/storage/mmkv';
import type {SavedPlace} from '../domain/entities';
import {HttpSavedPlacesRepository} from './httpPlacesRepository';

/** Doble mínimo de HttpClient: solo los verbos que usa el repo de lugares. */
function makeHttp(overrides: Partial<HttpClient>): HttpClient {
  return {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    ...overrides,
  } as unknown as HttpClient;
}

/** Mock de GET que PARSEA la fixture con el schema zod que le pasa el repo (como el HttpClient real). */
function getWithParse(raw: unknown): jest.Mock {
  return jest.fn((_path: string, opts?: {schema?: ZodType<unknown>}) =>
    Promise.resolve(opts?.schema ? opts.schema.parse(raw) : raw),
  );
}

/** Caché KeyValueStore en memoria: solo se usan getJSON/setJSON en el repo. */
function makeCache(seed?: SavedPlace[]): KeyValueStore {
  const store = new Map<string, unknown>();
  if (seed) {
    store.set('places.http.cache', seed);
  }
  return {
    getString: () => undefined,
    setString: () => undefined,
    getJSON: <T>(key: string) => store.get(key) as T | undefined,
    setJSON: <T>(key: string, value: T) => void store.set(key, value),
    getBoolean: () => undefined,
    setBoolean: () => undefined,
    has: (key: string) => store.has(key),
    remove: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  };
}

/** DTO válido según `savedPlace` (coordenadas planas, subtitle nullable). */
const HOME_DTO = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'HOME' as const,
  label: 'Casa',
  subtitle: 'Av. Siempre Viva 742',
  lat: -12.0464,
  lng: -77.0428,
  createdAt: '2026-07-01T10:00:00.000Z',
};

const CACHED_PLACE: SavedPlace = {
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'FAVORITE',
  label: 'Gimnasio',
  point: {lat: -12.1, lng: -77.03},
  createdAt: '2026-07-02T10:00:00.000Z',
};

/** Deja correr los microtasks para que resuelva la hidratación de fondo disparada por `list()`. */
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

describe('HttpSavedPlacesRepository · propagación del error de carga', () => {
  it('caché VACÍO + GET falla → propaga por onLoadError (no queda muda como falso vacío)', async () => {
    const get = jest.fn(() =>
      Promise.reject(new ApiError(0, 'NETWORK', 'sin red')),
    );
    const onLoadError = jest.fn();
    const onCacheUpdated = jest.fn();
    const repo = new HttpSavedPlacesRepository(makeHttp({get}), makeCache(), {
      onLoadError,
      onCacheUpdated,
    });

    // list() sirve el caché (vacío) YA y dispara el GET de fondo que fallará.
    expect(repo.list()).toEqual([]);
    await flush();

    expect(onLoadError).toHaveBeenCalledTimes(1);
    expect(onLoadError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onCacheUpdated).not.toHaveBeenCalled();
  });

  it('caché CON datos + GET falla → NO propaga (degradación offline honesta: se muestra lo cacheado)', async () => {
    const get = jest.fn(() =>
      Promise.reject(new ApiError(500, 'SERVER', 'boom')),
    );
    const onLoadError = jest.fn();
    const repo = new HttpSavedPlacesRepository(
      makeHttp({get}),
      makeCache([CACHED_PLACE]),
      {onLoadError},
    );

    // La lista sigue viva con el caché; el error de fondo NO molesta al usuario.
    expect(repo.list()).toHaveLength(1);
    await flush();

    expect(onLoadError).not.toHaveBeenCalled();
  });

  it('GET ok → rehidrata caché y avisa por onCacheUpdated (no onLoadError)', async () => {
    const get = getWithParse([HOME_DTO]);
    const onLoadError = jest.fn();
    const onCacheUpdated = jest.fn();
    const cache = makeCache();
    const repo = new HttpSavedPlacesRepository(makeHttp({get}), cache, {
      onLoadError,
      onCacheUpdated,
    });

    repo.list();
    await flush();

    expect(onCacheUpdated).toHaveBeenCalledTimes(1);
    expect(onLoadError).not.toHaveBeenCalled();
    // El caché quedó rehidratado con el recurso del servidor (mapeado a dominio).
    expect(repo.list()).toEqual([
      expect.objectContaining({id: HOME_DTO.id, kind: 'HOME', label: 'Casa'}),
    ]);
  });
});
