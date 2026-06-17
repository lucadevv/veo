import type {PanicKey} from '@veo/api-client';

/**
 * Abstracción de obtención de la CLAVE HMAC de pánico (DIP).
 *
 * El secreto es COMPARTIDO (no per-user) y lo emite el public-bff (`GET /auth/panic-key`, JWT
 * pasajero). NO se inventa en el cliente: solo se descarga y se persiste en el almacén seguro.
 */
export interface PanicKeyRepository {
  /** GET /auth/panic-key → secreto HMAC compartido + versión del mensaje canónico. */
  fetchKey(): Promise<PanicKey>;
}
