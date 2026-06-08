/** Plataforma del token de push (define el proveedor: FCM en Android, APNs/FCM en iOS). */
export type PushPlatform = 'android' | 'ios';

/**
 * Puerto de REGISTRO del device token de push (DIP).
 *
 * El pasajero debe enviar su token (FCM/APNs) al backend para recibir notificaciones (p. ej. avisos
 * de viaje, confirmaciones de pánico). La implementación REAL (`HttpPushTokenRegistrar`) llama al
 * public-bff: `POST /devices { token, platform }` para alta y `DELETE /devices/:token` para baja,
 * autenticados con el Bearer del pasajero. En sandbox sin Firebase se usa el fallback de log.
 */
export interface PushTokenRegistrar {
  /** Registra (o actualiza) el token del dispositivo en el backend. */
  register(token: string, platform: PushPlatform): Promise<void>;
  /** Da de baja el token (p. ej. al cerrar sesión). */
  unregister(token: string): Promise<void>;
}
