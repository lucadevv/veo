/**
 * Puerto del cliente gRPC a identity-service (veo.identity.v1.IdentityService).
 *
 * dispatch lo usa para RE-VALIDAR la elegibilidad del conductor en el SUBMIT de una oferta de la PUJA
 * (ADR 010 §6, defensa en profundidad / MENTORIA capa 3): el estado AUTORITATIVO de online/suspendido
 * vive en identity, NO en el hot-index de GPS. La presencia en el hot-index ya no autoriza ofertar
 * (cierre estructural del catastrófico #9 de la auditoría).
 *
 * (D de SOLID: el gate de elegibilidad depende de esta interfaz, no de @grpc/grpc-js directamente.
 * En tests unitarios se inyecta un fake que respeta el MISMO contrato.)
 */
export const IDENTITY_CLIENT = Symbol('IDENTITY_CLIENT');

/** Vista autoritativa del conductor según identity-service (lectura síncrona por gRPC). */
export interface IdentityDriver {
  id: string;
  userId: string;
  /** Estado del conductor: OFFLINE | AVAILABLE | ASSIGNED | ON_TRIP | ON_BREAK | SUSPENDED. */
  currentStatus: string;
  /** ISO-8601 de la suspensión; null si NO está suspendido. */
  suspendedAt: string | null;
  /** false cuando identity no encontró al conductor (driverId desconocido). */
  found: boolean;
}

export interface IdentityClient {
  /** Lee el conductor por su id. `found=false` si no existe (identity nunca lanza cross-servicio). */
  getDriver(driverId: string): Promise<IdentityDriver>;
  /**
   * Lee el conductor por su **User.id** (identity resuelve User.id → perfil Driver). `found=false` si no
   * existe. Lo usa la exclusión por suspensión del eje FLEET: el evento de la vía ITV llega keyeado por
   * User.id (= `Vehicle.driverId`), no por id de perfil — identity es el dueño del mapeo (no lo duplicamos).
   */
  getDriverByUser(userId: string): Promise<IdentityDriver>;
}
