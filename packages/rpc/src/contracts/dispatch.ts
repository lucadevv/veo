/**
 * Tipos wire de veo.dispatch.v1 (proto/dispatch.proto) — FUENTE ÚNICA para todos los consumidores.
 * Derivados a mano del .proto canónico con la semántica del loader de @veo/rpc
 * (keepCase:false → camelCase; defaults:true → proto3 entrega ""/0/false/[], nunca null).
 */

/** dispatch.GetMatch / mensaje MatchReply. */
export interface MatchReply {
  id: string;
  tripId: string;
  driverId: string;
  score: number;
  attempt: number;
  surgeMultiplier: number;
  outcome: string;
  offeredAt: string;
  respondedAt: string;
  found: boolean;
}

/** dispatch.GetSurge / mensaje SurgeReply. */
export interface SurgeReply {
  multiplier: number;
  zoneId: string;
  active: boolean;
}

/** Conductor cercano ANÓNIMO: SOLO posición + tipo, sin identidad (anti-rastreo). */
export interface NearbyDriver {
  lat: number;
  lon: number;
  vehicleType: string;
}

/** dispatch.GetNearbyDrivers → autitos de ambiente del mapa del pasajero (sin driverId). */
export interface NearbyDriversReply {
  drivers: NearbyDriver[];
}
