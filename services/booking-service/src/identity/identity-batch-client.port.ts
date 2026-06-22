/**
 * Puerto del cliente gRPC BATCH a identity-service (veo.identity.v1.IdentityService.GetDriversByIds).
 *
 * booking lo usa para ENRIQUECER los resultados de la BÚSQUEDA de viajes (F2, §6.2) con los datos PÚBLICOS
 * del conductor (nombre, rating) SIN incurrir en N+1: tras la query geo se juntan los `driverId` ÚNICOS y se
 * resuelven en UNA sola llamada batch (no una `GetDriver` por viaje). Esto es la herramienta anti-N+1 — el
 * gate marca `n-plus-one` y debe dar CERO.
 *
 * Campos PÚBLICOS únicamente (minimización H8): identity NO descifra DNI en batch; este reply trae name +
 * averageRating + currentStatus, nada de PII sensible. El viaje en sí no porta PII.
 *
 * POLÍTICA de degradación HONESTA (a diferencia de los gates F1a que son fail-closed): si identity NO
 * responde, la búsqueda NO se cuelga — devuelve los viajes SIN el enriquecimiento del conductor (driver
 * null). El viaje es público y útil sin el nombre del conductor; bloquear la búsqueda entera por identity
 * caída sería peor UX. La IMPLEMENTACIÓN puede lanzar; el SERVICE traduce el fallo a "sin enriquecer".
 *
 * (D de SOLID: el service depende de esta interfaz, no de @grpc/grpc-js. En tests se inyecta un fake que
 * cuenta las llamadas — la aserción anti-N+1 es "UNA sola invocación para N viajes".)
 */
export const IDENTITY_BATCH_CLIENT = Symbol('IDENTITY_BATCH_CLIENT');

/**
 * Vista PÚBLICA de un conductor para enriquecer un viaje (sin PII · minimización H8).
 *
 * Incluye los ejes de ELEGIBILIDAD (currentStatus / suspendedAt / kycStatus) que identity ya trae en el reply
 * batch (DriverReply): la BÚSQUEDA (F2 · FIX 3) los usa para FILTRAR ofertas de conductores que fueron
 * SUSPENDIDOS / KYC-revocados DESPUÉS de publicar (el gate de publish es one-shot). NO son PII sensible —
 * son el estado operativo público del conductor; el predicado `isDriverEligible` los juzga (fuente única).
 */
export interface PublicDriver {
  id: string;
  /** Nombre visible del conductor; "" si no registrado (proto3 default). */
  name: string;
  /** Rating promedio del conductor (0 si no tiene ratings aún). */
  averageRating: number;
  /** Estado operativo del conductor (DriverStatus). FIX 3: SUSPENDED → su oferta NO se muestra. */
  currentStatus: string;
  /** ISO-8601 de suspensión; "" si NO está suspendido (proto3 default). FIX 3: presente → no elegible. */
  suspendedAt: string;
  /** KYC del conductor (KycStatus). FIX 3: distinto de VERIFIED → su oferta NO se muestra. */
  kycStatus: string;
  /**
   * Revisión de antecedentes (BR-I01): PENDING | CLEARED | REJECTED. FIX 1·F2: distinto de CLEARED → su oferta
   * NO se muestra. Es el MISMO eje que el gate de publish exige — viaja en el `DriverReply` del batch (mismo
   * proto que `GetDriver`), así el predicado ÚNICO `isDriverEligible` se evalúa COMPLETO también en la búsqueda
   * (cierra la asimetría publish↔search). No es PII: es estado operativo público (igual que currentStatus/kyc).
   */
  backgroundCheckStatus: string;
  /** false si identity NO encontró al conductor (driverId desconocido). FIX 3: no elegible. */
  found: boolean;
}

export interface IdentityBatchClient {
  /**
   * Resuelve en UNA llamada los datos PÚBLICOS de varios conductores por sus ids (anti-N+1). El orden del
   * reply es libre: el consumidor mapea por id. Lista de ids vacía → no llama (devuelve []).
   */
  getDriversByIds(ids: string[]): Promise<PublicDriver[]>;
}
