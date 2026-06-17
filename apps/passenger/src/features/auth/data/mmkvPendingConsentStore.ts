import type { KeyValueStore } from '../../../core/storage/mmkv';
import {
  type PendingConsent,
  PendingConsentStatus,
  type PendingConsentStore,
} from '../domain/pendingConsent';

/** Clave de preferencia: aceptación de consentimiento encolada (no es dato sensible). */
const KEY = 'consent.pending';

/**
 * Implementación de `PendingConsentStore` sobre el almacén de preferencias (MMKV no cifrado),
 * espejando `onboardingStore`/`LocalTripHistoryRepository`: el contenido no es sensible (son flags
 * de consentimiento + un dedupKey de idempotencia, NO PII ni material criptográfico).
 *
 * Solo se persiste el estado `Pending`: vaciar la cola se modela como borrar la clave (`Idle` es la
 * AUSENCIA de valor), no como un valor `idle` guardado.
 */
export class MmkvPendingConsentStore implements PendingConsentStore {
  constructor(private readonly store: KeyValueStore) {}

  read(): PendingConsent | null {
    const value = this.store.getJSON<PendingConsent>(KEY);
    // Defensa por si quedó un valor de un formato anterior: solo aceptamos `Pending` bien formado.
    if (value === undefined || value.status !== PendingConsentStatus.Pending) {
      return null;
    }
    return value;
  }

  save(p: PendingConsent): void {
    this.store.setJSON(KEY, p);
  }

  clear(): void {
    this.store.remove(KEY);
  }
}
