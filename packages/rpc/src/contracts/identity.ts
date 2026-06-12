/**
 * Tipos wire de veo.identity.v1 (proto/identity.proto) — FUENTE ÚNICA para todos los consumidores.
 * Derivados a mano del .proto canónico con la semántica del loader de @veo/rpc
 * (keepCase:false → camelCase; defaults:true → proto3 entrega ""/0/false, nunca null).
 */

/** identity.GetUser / mensaje UserReply. */
export interface UserReply {
  id: string;
  phone: string;
  type: string;
  kycStatus: string;
  deleted: boolean;
  found: boolean;
  /** Nombre visible del usuario; "" si no fue registrado. */
  name: string;
}

/** identity.GetDriver / GetDriverByUser / mensaje DriverReply. */
export interface DriverReply {
  id: string;
  userId: string;
  currentStatus: string;
  backgroundCheckStatus: string;
  averageRating: number;
  found: boolean;
  /**
   * ISO-8601 del momento de suspensión del conductor; "" si NO está suspendido. Lo consume dispatch
   * para el gate de elegibilidad de la PUJA (ADR 010 §6) y el panel de ops (fecha de suspensión).
   */
  suspendedAt: string;
  /** BE-1b · nombre visible del conductor (de User.name vía driver→user); "" si no registrado. */
  name: string;
  /**
   * Motivo del último rechazo de antecedentes; "" si NO está rechazado o no se dio motivo. Lo consume
   * el driver-bff (GET /drivers/me) para que la app muestre el motivo en la pantalla de rechazo.
   */
  rejectionReason: string;
}
