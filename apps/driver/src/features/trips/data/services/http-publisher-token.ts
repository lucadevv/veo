import type {HttpClient} from '@veo/api-client';
import { driverPublisherGrant} from '@veo/api-client';
import {
  PublisherTokenUnavailableError,
  type PublisherCredentials,
  type PublisherTokenPort,
} from '../../domain/ports/trip-media-publisher';

/**
 * Implementación HTTP del puerto de token de publisher contra el driver-bff.
 *
 * Contrato real: `POST /media/rooms/:tripId/publisher-token` (JWT driver) → `driverPublisherGrant`
 * `{ url, token, room }`. El bff lee/crea la sala LiveKit del media-service para el viaje y acuña un
 * token de publicación (`canPublish`) del conductor. Cualquier fallo (incl. 404/403) se traduce a un
 * error de dominio claro: NO se inventan credenciales.
 */
export class HttpPublisherTokenPort implements PublisherTokenPort {
  constructor(private readonly http: HttpClient) {}

  async fetchPublisherCredentials(tripId: string): Promise<PublisherCredentials> {
    try {
      const grant = await this.http.post(`/media/rooms/${encodeURIComponent(tripId)}/publisher-token`, {
        schema: driverPublisherGrant,
      });
      // El contrato del bff ya coincide con `PublisherCredentials` ({ url, token, room }).
      return {url: grant.url, token: grant.token, room: grant.room};
    } catch (error) {
      throw new PublisherTokenUnavailableError(
        error instanceof Error ? error.message : undefined,
      );
    }
  }
}
