import {type HttpClient, registerDevice} from '@veo/api-client';
import type {
  PushPlatform,
  PushTokenRegistrar,
} from '../domain/pushTokenRegistrar';

/**
 * Implementación REAL de `PushTokenRegistrar` contra el public-bff.
 *
 *  - `register` → `POST /devices { token, platform }` (204, sin cuerpo). Valida el body con el
 *    contrato soberano `registerDevice` de `@veo/api-client` antes de enviarlo.
 *  - `unregister` → `DELETE /devices/:token` (204). El token se codifica en la ruta.
 *
 * El Bearer del pasajero lo inyecta el `HttpClient` por petición. Sin mocks: si el backend falla,
 * el error se propaga al llamador (el arranque de FCM lo captura sin tumbar la app).
 */
export class HttpPushTokenRegistrar implements PushTokenRegistrar {
  constructor(private readonly http: HttpClient) {}

  async register(token: string, platform: PushPlatform): Promise<void> {
    const body = registerDevice.parse({token, platform});
    await this.http.post('/devices', {body});
  }

  async unregister(token: string): Promise<void> {
    await this.http.delete(`/devices/${encodeURIComponent(token)}`);
  }
}
