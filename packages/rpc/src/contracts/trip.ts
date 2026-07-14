/**
 * Tipos wire de veo.trip.v1 (proto/trip.proto) — FUENTE ÚNICA para todos los consumidores.
 * Derivados a mano del .proto canónico con la semántica del loader de @veo/rpc
 * (keepCase:false → camelCase; defaults:true → proto3 entrega ""/0/false/[], nunca null).
 */

/** Punto geográfico del viaje (lat/lon). Reusado por las paradas intermedias del TripReply. */
export interface GeoPoint {
  lat: number;
  lon: number;
}

/** trip.GetTrip / GetActiveTrip / GetActiveTripByDriver / GetPendingSettlementTrip / CloseTripByPassenger. */
export interface TripReply {
  id: string;
  passengerId: string;
  driverId: string;
  vehicleId: string;
  status: string;
  fareCents: number;
  currency: string;
  distanceMeters: number;
  durationSeconds: number;
  paymentMethod: string;
  childMode: boolean;
  penaltyCents: number;
  found: boolean;
  /** Re-entrada del cierre: ISO-8601 de cuándo el pasajero selló el cierre; "" si aún sin cerrar. */
  passengerClosedAt: string;
  /** ISO-8601; requestedAt SIEMPRE presente; completedAt/cancelledAt "" si no aplican (BFF → null). */
  requestedAt: string;
  completedAt: string;
  cancelledAt: string;
  originLat: number;
  originLng: number;
  destinationLat: number;
  destinationLng: number;
  /** Polyline persistida del viaje; "" si no la tiene (la app degrada a línea recta). */
  routePolyline: string;
  /** Paradas intermedias ordenadas (Ola 2B); [] si el viaje es directo (repeated nunca es null). */
  waypoints: GeoPoint[];
  /**
   * BE-2 · solicitudes especiales del pasajero (valores del enum SpecialRequest como string:
   * PET|LUGGAGE|CHILD_SEAT); [] si ninguna (proto3 repeated nunca es null). El conductor las VE en la
   * oferta entrante (ADR-018) para decidir antes de aceptar.
   */
  specialRequests: string[];
  /**
   * Modo de despacho CONGELADO del viaje (FIXED|PUJA · enum PricingMode como string). resolve-once-persist
   * (ADR-011). '' solo en el EMPTY_TRIP (viaje no hallado); el BFF lo re-mapea a null.
   */
  dispatchMode: string;
  /**
   * Tier SOLICITADO del viaje (CAR|MOTO · enum VehicleType como string), derivado de la oferta al crear
   * (ADR 013). OPTIONAL en el tipo (compat: un trip-service con el proto viejo no lo emite y los fixtures
   * existentes no lo construyen); con el proto nuevo llega SIEMPRE ('' en EMPTY_TRIP → null en el BFF).
   */
  vehicleType?: string;
}

/**
 * trip.GetDriverTripStats — request: conteo de viajes COMPLETED de un conductor (señal de confianza
 * "N viajes" en la card del pasajero). El driverId es el id de PERFIL Driver (dueño de las filas Trip).
 */
export interface DriverTripStatsRequest {
  driverId: string;
}

/** trip.GetDriverTripStats — reply: cantidad de viajes COMPLETED del conductor. */
export interface DriverTripStatsReply {
  completedTrips: number;
}

/**
 * trip.GetPassengerTripStats — request: conteo de viajes COMPLETED de un pasajero (señal de confianza
 * "N viajes" en la card del conductor). El passengerId es el userId del pasajero (dueño de las filas Trip).
 */
export interface PassengerTripStatsRequest {
  passengerId: string;
}

/** trip.GetPassengerTripStats — reply: cantidad de viajes COMPLETED del pasajero. */
export interface PassengerTripStatsReply {
  completedTrips: number;
}

/** trip.GetTripModesByIds — lote de ids de viaje (enriquecimiento MODO on-read de la lista OPS admin). */
export interface TripIdsRequest {
  ids: string[];
}

/** Modo de despacho de UN viaje. `dispatchMode` = FIXED|PUJA. Un id no hallado NO aparece en items. */
export interface TripModeItem {
  id: string;
  dispatchMode: string;
}

/** trip.GetTripModesByIds — modos por id, anti-N+1. Solo id+modo (sin PII). */
export interface TripModesReply {
  items: TripModeItem[];
}

/** trip.GetTripState / mensaje TripStateReply. */
export interface TripStateReply {
  id: string;
  status: string;
  found: boolean;
}

/**
 * Un viaje del historial (ListPassengerTrips). Subconjunto para la card de la lista; SIN nombre de
 * conductor (anti-N+1). Opcionales proto3 llegan "" (completedAt/cancelledAt/driverId/category).
 */
export interface TripHistoryItem {
  id: string;
  status: string;
  originLat: number;
  originLng: number;
  destinationLat: number;
  destinationLng: number;
  fareCents: number;
  currency: string;
  paymentMethod: string;
  distanceMeters: number;
  durationSeconds: number;
  requestedAt: string;
  completedAt: string;
  cancelledAt: string;
  driverId: string;
  /** Ola 2B · tier (CAR|MOTO). */
  vehicleType: string;
  /** Categoría/opción elegida (quoteOption.id); "" si no se eligió. */
  category: string;
}

/** trip.ListPassengerTrips → página keyset: items + nextCursor ("" = no hay más; BFF → null). */
export interface PassengerTripsReply {
  items: TripHistoryItem[];
  nextCursor: string;
}

/**
 * trip.ListDriverTrips — request del historial del CONDUCTOR. Espejo de ListPassengerTrips pero con
 * driverId (id de PERFIL Driver de identity, NO userId). La respuesta reusa PassengerTripsReply (el item
 * del historial es idéntico). El driverId lo FIJA el BFF desde el JWT (anti-IDOR); el cliente no lo provee.
 */
export interface ListDriverTripsRequest {
  driverId: string;
  /** Cursor opaco devuelto por la página previa (nextCursor). "" = arrancar desde el más reciente. */
  cursor: string;
  /** Tamaño de página pedido; el servidor lo acota a [1, MAX_HISTORY_PAGE]. 0/ausente → default. */
  limit: number;
}
