import type {KeyValueStore} from '../src/core/storage/mmkv';
import {LocalCameraSharePreferenceRepository} from '../src/features/trip/data/localCameraSharePreferenceRepository';
import {
  GetCameraSharePreferenceUseCase,
  SaveCameraSharePreferenceUseCase,
} from '../src/features/trip/domain/cameraShareUsecases';

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

describe('Camera share preference (degradación local · hueco de backend)', () => {
  const TRIP = 'trip-1';

  it('devuelve el default (sin compartir) cuando nunca se guardó', async () => {
    const repo = new LocalCameraSharePreferenceRepository(new MemoryStore());
    const get = new GetCameraSharePreferenceUseCase(repo);

    const pref = await get.execute(TRIP);

    expect(pref).toEqual({shareWithFamily: false, allowedContactIds: []});
  });

  it('persiste y relee la preferencia del pasajero por viaje', async () => {
    const repo = new LocalCameraSharePreferenceRepository(new MemoryStore());
    const save = new SaveCameraSharePreferenceUseCase(repo);
    const get = new GetCameraSharePreferenceUseCase(repo);

    await save.execute(TRIP, {
      shareWithFamily: true,
      allowedContactIds: ['c1', 'c2'],
    });

    expect(await get.execute(TRIP)).toEqual({
      shareWithFamily: true,
      allowedContactIds: ['c1', 'c2'],
    });
  });

  it('apagar el master desautoriza a todos los contactos (invariante de coherencia)', async () => {
    const repo = new LocalCameraSharePreferenceRepository(new MemoryStore());
    const save = new SaveCameraSharePreferenceUseCase(repo);
    const get = new GetCameraSharePreferenceUseCase(repo);

    // El llamador intenta guardar contactos con el master apagado: el usecase los descarta.
    await save.execute(TRIP, {
      shareWithFamily: false,
      allowedContactIds: ['c1', 'c2'],
    });

    expect(await get.execute(TRIP)).toEqual({
      shareWithFamily: false,
      allowedContactIds: [],
    });
  });

  it('aísla la preferencia por viaje (no se mezclan dos viajes)', async () => {
    const repo = new LocalCameraSharePreferenceRepository(new MemoryStore());
    const save = new SaveCameraSharePreferenceUseCase(repo);
    const get = new GetCameraSharePreferenceUseCase(repo);

    await save.execute('trip-a', {
      shareWithFamily: true,
      allowedContactIds: ['a'],
    });
    await save.execute('trip-b', {
      shareWithFamily: true,
      allowedContactIds: ['b'],
    });

    expect((await get.execute('trip-a')).allowedContactIds).toEqual(['a']);
    expect((await get.execute('trip-b')).allowedContactIds).toEqual(['b']);
  });
});
