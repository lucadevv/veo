import type { GeoPoint } from '@veo/api-client';

/**
 * Estado del permiso de ubicación de la app, en términos de DOMINIO (no del SDK):
 *  - `granted`      → la app puede ubicar (iOS "When in Use"/"Always"; Android permiso concedido).
 *  - `denied`       → el usuario negó el permiso (hay que mandarlo a Ajustes; el prompt ya no reaparece).
 *  - `undetermined` → aún no se pidió (se puede disparar el prompt del SO con `requestPermission`).
 *  - `restricted`   → bloqueado por control parental/MDM (iOS); el usuario no puede concederlo.
 */
export type LocationPermission = 'granted' | 'denied' | 'undetermined' | 'restricted';

/**
 * Disponibilidad de ubicación = permiso de la app ∩ servicios del dispositivo. Son dos ejes
 * INDEPENDIENTES: el permiso puede estar concedido y el GPS del teléfono apagado, o al revés. La UI
 * necesita distinguirlos para dar una salida ACCIONABLE (abrir Ajustes de la app vs. de ubicación)
 * en vez de un "no pudimos ubicarte" genérico.
 */
export interface LocationAvailability {
  /** `true` si los servicios de ubicación del dispositivo (GPS/Location Services) están encendidos. */
  servicesEnabled: boolean;
  /** Estado del permiso de la app. */
  permission: LocationPermission;
}

/**
 * Puerto de ubicación del dispositivo (DIP). La obtención REAL de GPS (permisos, background,
 * react-native-background-geolocation) la implementa la capa de datos; aquí solo se define la
 * abstracción para que casos de uso (cotizar, pánico) y la presentación dependan de ella, no de un
 * módulo concreto. Los tipos del SDK NO se filtran: el puerto habla en términos de dominio.
 */
export interface LocationProvider {
  /** Posición actual del pasajero. Rechaza si no hay permiso/fix disponible. */
  getCurrentPosition(): Promise<GeoPoint>;
  /** Suscribe a cambios de posición; devuelve una función para cancelar la suscripción. */
  watchPosition(onChange: (point: GeoPoint) => void): () => void;
  /** Lee el estado actual de permiso + servicios SIN disparar ningún prompt. */
  getAvailability(): Promise<LocationAvailability>;
  /**
   * Pide el permiso de ubicación al usuario (dispara el prompt del SO si está `undetermined`) y
   * resuelve con la disponibilidad resultante. Si el permiso ya estaba `denied`, el SO no muestra
   * prompt y la app debe derivar a Ajustes.
   */
  requestPermission(): Promise<LocationAvailability>;
  /**
   * Suscribe a cambios de disponibilidad (el usuario prende/apaga el GPS, concede/revoca el permiso
   * desde Ajustes, etc.). Es event-driven: el SO avisa, no hace falta poll. Devuelve la baja.
   */
  onAvailabilityChange(listener: (availability: LocationAvailability) => void): () => void;
}
