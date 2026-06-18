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
  // ── Campos de REVISIÓN del operador (admin-bff GET /ops/drivers/:id). Todos opcionales: "" cuando
  // no hay dato (proto3 defaults:true → nunca null). Backward-compatible (campos 10-15 del proto). ──
  /** Licencia/DNI del conductor (IDENTIDAD personal · Compliance+); "" si no registrada. */
  licenseNumber: string;
  /** Estado KYC del usuario asociado (driver→user); "" si no se incluyó / no registrado. */
  kycStatus: string;
  /** ISO-8601 de alta del conductor; "" si no disponible. */
  createdAt: string;
  /** ISO-8601 del enrolamiento biométrico facial; "" si aún no enroló. */
  faceEnrolledAt: string;
  /** ISO-8601 de la última verificación biométrica en vivo; "" si nunca verificó. */
  lastVerifiedAt: string;
  /** Teléfono del usuario asociado (driver→user); "" si no registrado. */
  phone: string;
}
