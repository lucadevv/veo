/**
 * Tipos wire de veo.media.v1 (proto/media.proto) — FUENTE ÚNICA para todos los consumidores.
 * Derivados a mano del .proto canónico con la semántica del loader de @veo/rpc
 * (keepCase:false → camelCase; longs:String → int64 llega como string; defaults:true).
 */

/** Metadatos de un segmento de video (NUNCA URLs: la URL firmada exige doble autorización BR-S02). */
export interface Segment {
  id: string;
  tripId: string;
  startedAt: string;
  endedAt: string;
  s3Key: string;
  /** int64 serializado como string por el loader (longs:String). */
  sizeBytes: string;
  codec: string;
  retentionUntil: string;
  accessedCount: number;
  hasPanic: boolean;
  hasIncident: boolean;
}

/** media.GetSegments / mensaje SegmentsReply. */
export interface SegmentsReply {
  segments: Segment[];
}
