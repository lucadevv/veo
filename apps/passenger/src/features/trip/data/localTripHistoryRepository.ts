import type {TripResource} from '@veo/api-client';
import type {KeyValueStore} from '../../../core/storage/mmkv';
import type {TripHistoryRepository} from '../domain/tripHistoryRepository';

/** Clave de persistencia y tope de viajes guardados (evita crecer sin límite). */
const KEY = 'trips.history';
const MAX_ENTRIES = 50;

/**
 * Historial local sobre MMKV (prefs). Guarda los `TripResource` REALES devueltos por el bff,
 * de-duplicando por id (la última versión gana) y ordenando por `requestedAt` descendente.
 */
export class LocalTripHistoryRepository implements TripHistoryRepository {
  constructor(private readonly store: KeyValueStore) {}

  record(trip: TripResource): void {
    const current = this.list();
    const next = [trip, ...current.filter(item => item.id !== trip.id)]
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
      .slice(0, MAX_ENTRIES);
    this.store.setJSON(KEY, next);
  }

  list(): TripResource[] {
    return this.store.getJSON<TripResource[]>(KEY) ?? [];
  }

  clear(): void {
    this.store.remove(KEY);
  }
}
