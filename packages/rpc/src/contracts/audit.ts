/**
 * Tipos wire de veo.audit.v1 (proto/audit.proto) — FUENTE ÚNICA para todos los consumidores.
 * Derivados a mano del .proto canónico con la semántica del loader de @veo/rpc
 * (keepCase:false → camelCase; defaults:true → proto3 entrega ""/0/false, nunca null).
 */

/** audit.Record / mensaje RecordReply — entrada registrada en la cadena de auditoría. */
export interface RecordReply {
  id: string;
  /** seq como string para soportar bigint. */
  seq: string;
  hash: string;
}

/** audit.Verify / mensaje VerifyReply — verificación de integridad de un rango de la cadena. */
export interface VerifyReply {
  valid: boolean;
  checked: number;
  brokenAtSeq: string;
  reason: string;
}
