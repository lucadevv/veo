import type {ConsentSelection} from './usecases';

/**
 * Estado de la COLA DURABLE de consentimiento (Ley N.° 29733).
 *
 * `Idle` es la AUSENCIA de cola (no se persiste como tal: se borra la clave). `Pending` es una
 * aceptación capturada en el onboarding que todavía NO confirmó el servidor (red caída, sin sesión
 * aún, etc.). Estado tipado (sin strings mágicos) para que el resto del código no compare literales.
 */
export enum PendingConsentStatus {
  Idle = 'idle',
  Pending = 'pending',
}

/**
 * Aceptación de consentimiento ENCOLADA y persistida hasta que el backend la confirma.
 *
 * El `dedupKey` (UUIDv7) se genera UNA sola vez al encolar y se guarda ACÁ: todos los reintentos
 * (post-login, boot, foreground) reusan la MISMA clave, así el POST idempotente del backend nunca
 * duplica el row append-only (espeja la estrategia del pánico silencioso).
 */
export interface PendingConsent {
  status: PendingConsentStatus.Pending;
  /** Selección capturada en el onboarding (los flags aceptados por el usuario). */
  selection: ConsentSelection;
  /** Versión de política vigente al capturar (sello legal que viaja con la aceptación). */
  policyVersion: string;
  /** Clave de idempotencia compartida por TODOS los reintentos de esta aceptación. */
  dedupKey: string;
  /** Momento de la captura (ISO-8601), para auditoría/diagnóstico. */
  capturedAt: string;
  /** Cuántos intentos de entrega se hicieron (telemetría/diagnóstico; no decide reintentos). */
  attempts: number;
}

/**
 * Puerto de persistencia de la cola durable (DIP). La implementación concreta vive en `data/`
 * sobre MMKV (`prefsStore`); el dominio depende solo de esta abstracción. Síncrono: MMKV es lectura
 * instantánea (mismo contrato que el resto de stores locales de la app).
 */
export interface PendingConsentStore {
  /** Lee la aceptación encolada o `null` si la cola está vacía (`Idle`). */
  read(): PendingConsent | null;
  /** Persiste/reemplaza la aceptación encolada. */
  save(p: PendingConsent): void;
  /** Vacía la cola (la aceptación quedó confirmada o fue reconciliada). */
  clear(): void;
}
