import type {TripResource} from '@veo/api-client';
import type {KeyValueStore} from '../src/core/storage/mmkv';
import {LocalTripHistoryRepository} from '../src/features/trip/data/localTripHistoryRepository';

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

function trip(id: string, requestedAt: string): TripResource {
  return {
    id,
    passengerId: 'pax',
    driverId: null,
    vehicleId: null,
    status: 'COMPLETED',
    origin: {lat: -12.04, lon: -77.04},
    destination: {lat: -12.1, lon: -77.0},
    fareCents: 1500,
    currency: 'PEN',
    surgeMultiplier: 1,
    distanceMeters: 5000,
    durationSeconds: 600,
    paymentMethod: 'CASH',
    routePolyline: null,
    childMode: false,
    penaltyCents: 0,
    requestedAt,
    completedAt: null,
    cancelledAt: null,
  };
}

describe('LocalTripHistoryRepository', () => {
  it('ordena por fecha descendente y de-duplica por id', () => {
    const repo = new LocalTripHistoryRepository(new MemoryStore());

    repo.record(trip('a', '2026-05-01T10:00:00.000Z'));
    repo.record(trip('b', '2026-05-03T10:00:00.000Z'));
    // Re-registra 'a' con estado actualizado: no debe duplicar.
    repo.record(trip('a', '2026-05-01T10:00:00.000Z'));

    const list = repo.list();
    expect(list).toHaveLength(2);
    expect(list[0]!.id).toBe('b');
    expect(list[1]!.id).toBe('a');
  });

  it('limpia el historial', () => {
    const repo = new LocalTripHistoryRepository(new MemoryStore());
    repo.record(trip('a', '2026-05-01T10:00:00.000Z'));
    repo.clear();
    expect(repo.list()).toHaveLength(0);
  });
});
