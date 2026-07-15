/**
 * Puerto de resolución de identidad (identity-service · veo.identity.v1.IdentityService).
 *
 * POR QUÉ existe (ADR-015 D7 · gate del Lote 4): algunos eventos de dominio targetean al CONDUCTOR por su
 * `Driver.id` (el id propio del agregado del conductor), NO por la cuenta `userId`. Pero el device-token
 * store de este servicio se consulta por `userId` (así se registran los devices). `Driver.id ≠ userId`
 * (dos columnas UUID distintas en identity) → resolver tokens por `driverId` NO matchea jamás y el push
 * se omite en silencio. El caso vivo: `payout.processed` lleva `driverId` y el conductor NUNCA recibía el
 * aviso de su liquidación. Acá resolvemos `driverId → userId` SÍNCRONAMENTE por gRPC contra identity
 * (dueño del dato) justo antes del lookup de device-token.
 *
 * Abstracción (DIP): el motor del push depende de esta INTERFAZ, no del cliente gRPC concreto → testeable
 * con un doble en memoria y sustituible si identity cambia de transporte (espeja booking-service).
 */
export const IDENTITY_CLIENT = Symbol('IDENTITY_CLIENT');

/** Vista MÍNIMA del conductor según identity (lo único que este servicio necesita: la cuenta dueña). */
export interface IdentityDriver {
  /** Cuenta `userId` dueña del conductor (la clave del device-token store). "" si no encontrado. */
  userId: string;
  /** false cuando identity no encontró al conductor (driverId desconocido). */
  found: boolean;
}

export interface IdentityClient {
  /**
   * Resuelve el conductor por su `Driver.id`. `found=false` si no existe (identity nunca lanza
   * cross-servicio por un id desconocido). PUEDE lanzar ante fallo de transporte (gRPC caído/timeout)
   * → el llamador degrada HONESTO (omite el push, no crashea el consumer).
   */
  getDriver(driverId: string): Promise<IdentityDriver>;
}
