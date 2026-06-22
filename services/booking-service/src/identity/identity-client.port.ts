/**
 * Puerto del cliente gRPC a identity-service (veo.identity.v1.IdentityService).
 *
 * booking lo usa para el GATE DE ELEGIBILIDAD del conductor al PUBLICAR una oferta de carpooling
 * (ADR-014 §4.1/§8, F1a · defensa en profundidad): el estado AUTORITATIVO de suspensión/KYC/antecedentes
 * vive en identity, NO en el token. La presencia de `driverId` en la identidad firmada autentica al
 * conductor, pero NO autoriza publicar — la elegibilidad se RE-VALIDA server-side contra identity.
 *
 * (D de SOLID: el gate depende de esta interfaz, no de @grpc/grpc-js directamente. En tests unitarios
 * se inyecta un fake que respeta el MISMO contrato.)
 *
 * POLÍTICA fail-closed (espeja dispatch): si identity no responde, la implementación LANZA y el gate
 * RECHAZA la publicación (ForbiddenError) — nunca un conductor no elegible colándose por un error de red.
 */
export const IDENTITY_CLIENT = Symbol('IDENTITY_CLIENT');

/** Vista autoritativa del conductor según identity-service (lectura síncrona por gRPC). */
export interface IdentityDriver {
  id: string;
  userId: string;
  /** Estado del conductor: OFFLINE | AVAILABLE | ASSIGNED | ON_TRIP | ON_BREAK | SUSPENDED. */
  currentStatus: string;
  /** Revisión de antecedentes (BR-I01): PENDING | CLEARED | REJECTED. Solo CLEARED habilita operar. */
  backgroundCheckStatus: string;
  /** KYC del conductor: PENDING | VERIFIED | REJECTED | EXPIRED. Solo VERIFIED habilita operar. */
  kycStatus: string;
  /** ISO-8601 de la suspensión; null si NO está suspendido (proto3 manda '' cuando no lo está). */
  suspendedAt: string | null;
  /** false cuando identity no encontró al conductor (driverId desconocido). */
  found: boolean;
  /**
   * Nombre visible del conductor (campo PÚBLICO · minimización H8); "" si no registrado. Lo consume el
   * DETALLE de un viaje (GET /published-trips/:id, F2) para mostrar quién maneja. No es PII sensible.
   */
  name: string;
  /** Rating promedio del conductor (campo PÚBLICO); 0 si aún no tiene ratings. Lo consume el detalle (F2). */
  averageRating: number;
}

export interface IdentityClient {
  /** Lee el conductor por su id. `found=false` si no existe (identity nunca lanza cross-servicio). */
  getDriver(driverId: string): Promise<IdentityDriver>;
}
