/**
 * Tipos de las respuestas gRPC (camelCase: proto-loader con keepCase:false convierte snake_case).
 * Espejan los mensajes de los .proto versionados en @veo/rpc. Solo lecturas Get*.
 */

export interface UserReply {
  id: string;
  phone: string;
  type: string;
  kycStatus: string;
  deleted: boolean;
  found: boolean;
}

export interface DriverReply {
  id: string;
  userId: string;
  currentStatus: string;
  backgroundCheckStatus: string;
  averageRating: number;
  found: boolean;
  /** BE-1b · nombre visible del conductor (de User.name). "" si no registrado. */
  name: string;
}

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
  /** Re-entrada del cierre: ISO-8601 de cuándo el pasajero selló el cierre; '' si aún sin cerrar (proto3). */
  passengerClosedAt: string;
  /**
   * Enriquecimiento del detalle de "Mis Viajes": timestamps reales + puntos del viaje + polyline. Suelta la
   * dependencia del snapshot MMKV local para la FECHA y el MAPA. requestedAt SIEMPRE presente; los opcionales
   * (completedAt/cancelledAt/routePolyline) llegan '' (proto3) y el BFF los re-mapea a null. Mismos nombres
   * que TripHistoryItemReply (originLat/originLng) por consistencia.
   */
  requestedAt: string;
  completedAt: string;
  cancelledAt: string;
  originLat: number;
  originLng: number;
  destinationLat: number;
  destinationLng: number;
  routePolyline: string;
  found: boolean;
}

export interface TripStateReply {
  id: string;
  status: string;
  found: boolean;
}

/**
 * Un viaje del historial del pasajero (ListPassengerTrips). Subconjunto pensado para la card de la
 * lista; SIN nombre de conductor (anti-N+1): solo driverId. proto3 manda '' para los opcionales nulos
 * (completedAt/cancelledAt/driverId/category); el BFF los re-mapea a null en la vista mobile.
 */
export interface TripHistoryItemReply {
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
  vehicleType: string;
  category: string;
}

/** Página del historial (ListPassengerTrips): items + nextCursor ('' = no hay más, re-mapeado a null). */
export interface PassengerTripsReply {
  items: TripHistoryItemReply[];
  nextCursor: string;
}

export interface SurgeReply {
  multiplier: number;
  zoneId: string;
  active: boolean;
}

/** dispatch.GetNearbyDrivers → autitos ANÓNIMOS de ambiente: SOLO posición + tipo (sin driverId). */
export interface NearbyDriverReply {
  lat: number;
  lon: number;
  vehicleType: string;
}

export interface NearbyDriversReply {
  drivers: NearbyDriverReply[];
}

export interface PaymentReply {
  id: string;
  tripId: string;
  method: string;
  status: string;
  amountCents: number;
  grossCents: number;
  commissionCents: number;
  feeCents: number;
  tipCents: number;
  externalRef: string | null;
  found: boolean;
  // Checkout asíncrono (ProntoPaga). proto3 string → llegan "" cuando no aplican; el BFF las re-mapea a null.
  externalUid: string;
  checkoutUrl: string;
  qrCode: string;
  deepLink: string;
  cip: string;
  checkoutExpiresAt: string;
  // Razón estructurada del fallo del cobro (failureReason del Payment). proto3 → "" cuando no hubo fallo;
  // el BFF la re-mapea a null. El charge/retry/method por REST la entregan en camelCase desde el Payment.
  failureReason: string;
}

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

export interface AggregateReply {
  subjectId: string;
  role: string;
  rollingAvg30d: number;
  count30d: number;
  flagged: boolean;
  flagReason: string;
  lastComputedAt: string;
  found: boolean;
}

export interface TrustedContactReply {
  id: string;
  userId: string;
  phone: string;
  name: string;
  relationship: string;
  otpVerified: boolean;
}

export interface TrustedContactsReply {
  contacts: TrustedContactReply[];
}

export interface VehicleReply {
  id: string;
  plate: string;
  make: string;
  model: string;
  year: number;
  color: string;
  docStatus: string;
  active: boolean;
  found: boolean;
}

/** fleet.GetDriverVehicles(driverId) → vehículos del conductor (BE-1: enriquecer la oferta sin match). */
export interface DriverVehiclesReply {
  driverId: string;
  vehicles: VehicleReply[];
}

/**
 * places-service (Lote B). El enum kind llega como string (proto-loader enums:String).
 * createdAt/updatedAt en ISO-8601. subtitle "" cuando no se registró.
 */
export interface SavedPlaceReply {
  id: string;
  kind: string;
  label: string;
  subtitle: string;
  lat: number;
  lng: number;
  createdAt: string;
  updatedAt: string;
}

/** places.ListByUser → lista ordenada (HOME, WORK, luego FAVORITEs por createdAt desc). */
export interface PlacesReply {
  places: SavedPlaceReply[];
}

/** places.Save / places.Update → el lugar resultante. */
export interface PlaceReply {
  place: SavedPlaceReply;
}

/** places.Remove → confirmación de borrado. */
export interface RemovePlaceReply {
  removed: boolean;
}
