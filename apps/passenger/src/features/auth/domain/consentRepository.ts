import type { ConsentRecorded, CurrentConsent, RecordConsentRequest } from '@veo/api-client';

/**
 * Abstracción del repositorio de consentimientos Ley N.° 29733 (DIP).
 *
 * El registro es APPEND-ONLY en el backend: cada aceptación crea un row inmutable y el estado
 * vigente es el más reciente. La IP de origen la añade el public-bff desde el request (NO se
 * envía desde el cliente).
 */
export interface ConsentRepository {
  /** POST /users/me/consents → registra la aceptación de consentimientos del pasajero. */
  record(input: RecordConsentRequest): Promise<ConsentRecorded>;
  /** GET /users/me/consents → consentimiento VIGENTE (el más reciente) o `null` si nunca registró. */
  getCurrent(): Promise<CurrentConsent>;
}
