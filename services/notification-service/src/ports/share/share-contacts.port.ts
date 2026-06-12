/**
 * Puerto de resolución de contactos de confianza (share-service) para el fan-out durable de pánico.
 *
 * SOBERANÍA §0.7: el evento `panic.fanout_requested` viaja por Kafka con SOLO IDs (sin teléfono ni
 * nombre). El teléfono/nombre — PII — se resuelve aquí SÍNCRONAMENTE por gRPC contra share-service
 * (dueño del dato), justo antes de encolar el SMS. Nunca se persiste ni se loguea esa PII.
 *
 * Abstracción (DIP): el handler depende de esta interfaz, no del cliente gRPC concreto → testeable
 * con un doble en memoria y sustituible si share cambia de transporte.
 */
export const SHARE_CONTACTS_RESOLVER = Symbol('SHARE_CONTACTS_RESOLVER');

/** Un contacto de confianza ya resuelto (con PII). Vive solo en memoria durante el fan-out. */
export interface ResolvedTrustedContact {
  id: string;
  phone: string;
  name: string;
}

export interface TrustedContactsResolver {
  /**
   * Devuelve los contactos de confianza VERIFICADOS del pasajero. Puede lanzar (gRPC caído) → el
   * llamador debe tratarlo como TRANSITORIO (relanzar para que Kafka reintente; el engine dedupea).
   */
  resolveByPassenger(passengerId: string): Promise<ResolvedTrustedContact[]>;
}
