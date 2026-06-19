/**
 * Puertos de notificaciones push (FCM/APNs) del conductor.
 *
 * - `PushRegistrationPort`: registra el device token en el backend.
 * - `PushService`: integra el SDK nativo (permisos, token, handlers foreground/background/quita).
 *
 * Regla #2 de CLAUDE.md (UI engañosa al pánico): los handlers NUNCA muestran alertas ni indicadores;
 * cualquier mensaje cuyo `data.type` sugiera pánico se ignora en la UI del conductor.
 */

export type DevicePlatform = 'ios' | 'android';

export interface DeviceTokenRegistration {
  token: string;
  platform: DevicePlatform;
}

/** Puerto del backend que asocia/desasocia el device token del conductor autenticado. */
export interface PushRegistrationPort {
  /** Asocia el token al conductor: `POST /notifications/device-token` (204). */
  registerDeviceToken(registration: DeviceTokenRegistration): Promise<void>;
  /** Desasocia el token (logout/rotación): `DELETE /notifications/device-token/:token` (204). */
  unregisterDeviceToken(token: string): Promise<void>;
}

/** Mensaje push normalizado (lo mínimo que necesita la app). */
export interface PushMessage {
  data?: Record<string, string | undefined>;
}

/**
 * Callback de DATA de un push NO sensible (pánico se filtra antes): recibe el `data` (IDs/deep-link, sin
 * PII). Lo usa la capa de presentación para REACCIONAR — p. ej. invalidar el gate de registro cuando llega
 * un push de aprobación/rechazo del conductor — SIN acoplar el servicio de transporte a React Query.
 */
export type OnPushDataMessage = (data: PushMessage['data']) => void;

export interface PushService {
  /**
   * Inicializa permisos + token, registra el token vía `register` y engancha los handlers
   * (foreground/quita). Devuelve una función de limpieza para desuscribir los listeners.
   * En dev (Firebase placeholder) degrada de forma silenciosa y devuelve un cleanup no-op.
   * `onDataMessage` (opcional): se invoca con el `data` de cada push NO-pánico (foreground/abierto/quit)
   * para que la presentación reaccione (refetch), sin que el servicio conozca el estado de la app.
   */
  start(register: PushRegistrationPort, onDataMessage?: OnPushDataMessage): Promise<() => void>;
  /**
   * Da de baja en el backend el último token FCM/APNs conocido (logout). Best-effort: si no hay token
   * o Firebase no está configurado, no hace nada. Debe llamarse mientras el JWT del conductor sigue
   * vigente (antes de limpiar la sesión).
   */
  unregisterCurrentToken(register: PushRegistrationPort): Promise<void>;
}

/** Código de error cuando el registro de device token falla en el driver-bff. */
export const PUSH_REGISTRATION_UNAVAILABLE = 'PUSH_REGISTRATION_UNAVAILABLE';

/** Error claro cuando el registro de token contra el driver-bff falla. */
export class PushRegistrationUnavailableError extends Error {
  readonly code = PUSH_REGISTRATION_UNAVAILABLE;
  constructor(message = 'No se pudo registrar el device token en el driver-bff') {
    super(message);
    this.name = 'PushRegistrationUnavailableError';
  }
}
