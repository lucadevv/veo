import {HttpClient, registerDevice} from '@veo/api-client';
import {
  PushRegistrationUnavailableError,
  type DeviceTokenRegistration,
  type PushRegistrationPort,
} from '../domain/ports/push';

/**
 * Registro/baja del device token contra el driver-bff (notification-service).
 *
 * Contrato real (JWT driver):
 *  - `POST /notifications/device-token` body `{ token, platform }` → 204.
 *  - `DELETE /notifications/device-token/:token` → 204.
 *
 * El cuerpo del POST se valida con el esquema `registerDevice` de `@veo/api-client` (fuente de verdad
 * del contrato) para garantizar la forma exacta antes de enviarlo. Cualquier fallo se traduce a un
 * error de dominio claro (no se simula el registro).
 */
export class HttpPushRegistrationPort implements PushRegistrationPort {
  constructor(private readonly http: HttpClient) {}

  async registerDeviceToken(registration: DeviceTokenRegistration): Promise<void> {
    try {
      const body = registerDevice.parse(registration);
      await this.http.post<void>('/notifications/device-token', {body});
    } catch (error) {
      throw new PushRegistrationUnavailableError(
        error instanceof Error ? error.message : undefined,
      );
    }
  }

  async unregisterDeviceToken(token: string): Promise<void> {
    try {
      await this.http.delete<void>(`/notifications/device-token/${encodeURIComponent(token)}`);
    } catch (error) {
      throw new PushRegistrationUnavailableError(
        error instanceof Error ? error.message : undefined,
      );
    }
  }
}
