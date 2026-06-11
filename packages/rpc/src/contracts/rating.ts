/**
 * Tipos wire de veo.rating.v1 (proto/rating.proto) — FUENTE ÚNICA para todos los consumidores.
 * Derivados a mano del .proto canónico con la semántica del loader de @veo/rpc
 * (keepCase:false → camelCase; defaults:true → proto3 entrega ""/0/false, nunca null).
 */

/** rating.GetAggregate / mensaje AggregateReply — agregado rolling 30d de un sujeto. */
export interface AggregateReply {
  subjectId: string;
  /** DRIVER | PASSENGER. */
  role: string;
  rollingAvg30d: number;
  count30d: number;
  flagged: boolean;
  /** "" si no está flagged. */
  flagReason: string;
  /** ISO-8601; "" si no hay agregado. */
  lastComputedAt: string;
  found: boolean;
}
