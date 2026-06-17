import {type HttpClient, type PanicKey, panicKey} from '@veo/api-client';
import type {PanicKeyRepository} from '../domain/panicKeyRepository';

/**
 * Implementación REAL de `PanicKeyRepository` contra el public-bff (`GET /auth/panic-key`).
 *
 * Valida la respuesta con el schema soberano `panicKey` de `@veo/api-client` (sin inventar formas):
 * `{ secret, version }`. El Bearer del pasajero lo inyecta el `HttpClient` por petición.
 */
export class HttpPanicKeyRepository implements PanicKeyRepository {
  constructor(private readonly http: HttpClient) {}

  fetchKey(): Promise<PanicKey> {
    return this.http.get('/auth/panic-key', {schema: panicKey});
  }
}
