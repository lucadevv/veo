/**
 * Tipos wire de veo.panic.v1 (proto/panic.proto) — FUENTE ÚNICA para todos los consumidores.
 * Derivados a mano del .proto canónico con la semántica del loader de @veo/rpc
 * (keepCase:false → camelCase; defaults:true → proto3 entrega ""/0/false, nunca null).
 */

/** panic.GetPanic / mensaje PanicReply. */
export interface PanicReply {
  id: string;
  tripId: string;
  passengerId: string;
  status: string;
  geoLat: number;
  geoLon: number;
  triggeredAt: string;
  acknowledgedAt: string;
  ackBy: string;
  found: boolean;
}
