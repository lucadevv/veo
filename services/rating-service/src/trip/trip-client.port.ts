/**
 * Puerto del cliente gRPC a trip-service (veo.trip.v1.TripService).
 *
 * rating-service lo usa para VALIDAR, en el submit de una calificación, que el viaje exista, esté
 * COMPLETED y que el rater haya participado (gate fail-closed del create). El estado AUTORITATIVO del
 * viaje vive en trip-service, NO en rating-service: una calificación sobre un viaje no completado o de
 * alguien que no viajó es un dato corrupto, así que se rechaza ANTES de tocar la DB.
 *
 * (D de SOLID: el gate de validación depende de esta interfaz, no de @grpc/grpc-js directamente.
 * En tests unitarios se inyecta un fake que respeta el MISMO contrato.)
 */
export const TRIP_CLIENT = Symbol('TRIP_CLIENT');

/** Vista del viaje según trip-service necesaria para el gate de calificación. */
export interface TripView {
  /** Estado del viaje (veo.trip.v1, ej. COMPLETED). String wire; se compara contra TripStatus. */
  status: string;
  /** Pasajero del viaje. */
  passengerId: string;
  /** Conductor del viaje; "" si nunca se asignó (proto3). */
  driverId: string;
}

export interface TripClient {
  /**
   * Lee el viaje por su id. `null` si trip-service no lo encontró (found=false / NOT_FOUND).
   * NO atrapa fallos de transporte: si trip-service no responde, PROPAGA el error (fail-closed —
   * si no se puede verificar el viaje, no se permite calificar).
   */
  getTrip(tripId: string): Promise<TripView | null>;
}
