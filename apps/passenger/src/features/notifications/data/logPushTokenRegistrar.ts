import type { PushPlatform, PushTokenRegistrar } from '../domain/pushTokenRegistrar';

/**
 * Registrar de dev/sandbox: registra el token en consola en lugar de enviarlo al backend.
 *
 * Es el FALLBACK cuando Firebase está deshabilitado (sandbox sin credenciales): no hay token FCM/APNs
 * real que registrar, así que solo deja trazas para desarrollo. Con `FIREBASE_ENABLED=true` se usa el
 * `HttpPushTokenRegistrar` real contra `POST /devices` · `DELETE /devices/:token`.
 */
export class LogPushTokenRegistrar implements PushTokenRegistrar {
  register(token: string, platform: PushPlatform): Promise<void> {
    console.warn(
      `[push] token de dispositivo (${platform}) listo para registrar (sandbox, Firebase deshabilitado): ${token.slice(0, 12)}…`,
    );
    return Promise.resolve();
  }

  unregister(_token: string): Promise<void> {
    console.warn('[push] baja de token (sandbox, Firebase deshabilitado)');
    return Promise.resolve();
  }
}
