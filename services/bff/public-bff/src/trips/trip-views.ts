/**
 * Mappers puros del dominio de viajes (sin I/O): agregan las respuestas gRPC de trip + identity
 * (conductor) + rating (agregado) + fleet (vehículo) en la vista que consume la app del pasajero.
 * Aislados para poder testearlos directamente.
 */
import { DOMAIN_STATUS_ALIASES, normalizeTripStatus, type TripStatus } from '@veo/api-client';
import { ExternalServiceError } from '@veo/utils';
import type {
  AggregateReply,
  DriverReply,
  PassengerTripsReply,
  TripHistoryItemReply,
  TripReply,
  TripStateReply,
  VehicleReply,
} from '../infra/grpc-types';

export interface TripDriverView {
  id: string;
  /** Nombre visible del conductor (de identity User.name); null si aún no lo tiene. SEGURIDAD: el
   *  pasajero confirma a quién sube. Antes faltaba → la app mostraba "Conductor" genérico. */
  name: string | null;
  status: string;
  backgroundCheckStatus: string;
  rating: number | null;
  ratingCount: number;
}

export interface TripVehicleView {
  id: string;
  plate: string;
  make: string;
  model: string;
  year: number;
  color: string;
}

export interface TripDetailView {
  id: string;
  status: TripStatus;
  passengerId: string;
  fareCents: number;
  currency: string;
  /**
   * Propina acumulada del viaje (100% al conductor, fuera de comisión). La fuente autoritativa es
   * el pago (paymentView); aquí se incluye si el detalle pudo resolverlo, 0 en caso contrario.
   */
  tipCents: number;
  distanceMeters: number;
  durationSeconds: number;
  paymentMethod: string;
  childMode: boolean;
  penaltyCents: number;
  /**
   * Re-entrada del cierre post-viaje: ISO-8601 de cuándo el pasajero selló el cierre, o null si aún sin
   * cerrar. La app lo usa para no re-ofrecer el cierre de un viaje YA cerrado y para mostrar honestamente
   * el estado. El gRPC lo manda como '' cuando es null (proto3); acá se re-mapea a null.
   */
  passengerClosedAt: string | null;
  /**
   * Detalle de "Mis Viajes" (enriquecimiento): suelta la dependencia del snapshot MMKV local para la FECHA.
   * requestedAt SIEMPRE presente; completedAt/cancelledAt null si el viaje no llegó a ese terminal.
   */
  requestedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  /** Puntos del viaje (mismo {lat,lng} que TripHistoryItem; la app los convierte a {lat,lon} internamente). */
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  /**
   * Ruta del viaje codificada (polyline), persistida por trip-service (Trip.routePolyline); null si el viaje
   * no la tiene. La app la pinta en el mapa del detalle; si es null degrada a línea recta origen→destino.
   */
  routePolyline: string | null;
  driver: TripDriverView | null;
  vehicle: TripVehicleView | null;
  /**
   * MI calificación (estrellas 1..5) de ESTE viaje: la que el pasajero le dio al conductor, o `null` si
   * aún no calificó. Enriquecido por el BFF (rating-service, REST firmado, filtrado por el rater) para
   * que el detalle / la re-entrada del cierre rendericen el estado del rating SIN un GET extra. Es
   * best-effort: si rating-service está caído, queda `null` (la app cae al GET /ratings?tripId on-demand).
   */
  myRatingStars: number | null;
}

export interface TripStateView {
  id: string;
  status: TripStatus;
}

/**
 * Un viaje en el historial del pasajero (card de "Mis Viajes"). Trae el ESTADO REAL del servidor
 * (COMPLETED / CANCELLED / EXPIRED), que la lista local de la app no tiene. SIN nombre de conductor
 * (anti-N+1): solo driverId; el nombre lo resuelve el DETALLE (GET /trips/:id) on-demand al abrir el viaje.
 */
export interface TripHistoryItemView {
  id: string;
  status: TripStatus;
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  fareCents: number;
  currency: string;
  paymentMethod: string;
  distanceMeters: number;
  durationSeconds: number;
  /** ISO-8601, siempre presente. */
  requestedAt: string;
  /** ISO-8601 o null si el viaje no llegó a COMPLETED. */
  completedAt: string | null;
  /** ISO-8601 o null si el viaje no fue cancelado. */
  cancelledAt: string | null;
  /** null si el viaje nunca tuvo conductor (EXPIRED). La app resuelve el nombre en el detalle. */
  driverId: string | null;
  /** Tier (CAR|MOTO). */
  vehicleType: string;
  /** Categoría/opción elegida (quoteOption.id); null si no se eligió. */
  category: string | null;
}

/** Página del historial: items + cursor de la siguiente página (null si no hay más). */
export interface TripHistoryPageView {
  items: TripHistoryItemView[];
  nextCursor: string | null;
}

// El mapa de alias dominio→mobile vive en @veo/api-client (fuente única). Se re-exporta para los
// consumidores internos que aún lo referencian directo (p. ej. share/family-view).
export { DOMAIN_STATUS_ALIASES };

/**
 * Normaliza un status crudo del downstream al enum compartido; lanza 5xx de servicio si es desconocido.
 * La normalización (alias + parse) la centraliza `normalizeTripStatus` de @veo/api-client; aquí solo se
 * aplica la POLÍTICA DE ERROR del BFF (un estado fuera de contrato es una falla del downstream).
 */
export function toTripStatus(raw: string): TripStatus {
  const normalized = normalizeTripStatus(raw);
  if (!normalized) {
    throw new ExternalServiceError('Estado de viaje desconocido', { status: raw });
  }
  return normalized;
}

/** Construye la vista de conductor combinando datos de identity y el agregado de rating. */
export function buildDriverView(
  driver: DriverReply | null,
  aggregate: AggregateReply | null,
): TripDriverView | null {
  if (!driver) return null;
  const rating =
    aggregate && aggregate.count30d > 0
      ? aggregate.rollingAvg30d
      : driver.averageRating > 0
        ? driver.averageRating
        : null;
  return {
    id: driver.id,
    // El nombre viene de identity (DriverReply.name); '' (proto3 default) se normaliza a null.
    name: driver.name && driver.name.length > 0 ? driver.name : null,
    status: driver.currentStatus,
    backgroundCheckStatus: driver.backgroundCheckStatus,
    rating,
    ratingCount: aggregate?.count30d ?? 0,
  };
}

/** Construye la vista de vehículo desde fleet. */
export function buildVehicleView(vehicle: VehicleReply | null): TripVehicleView | null {
  if (!vehicle) return null;
  return {
    id: vehicle.id,
    plate: vehicle.plate,
    make: vehicle.make,
    model: vehicle.model,
    year: vehicle.year,
    color: vehicle.color,
  };
}

/** Agrega trip + conductor + rating del conductor + vehículo + MI rating en la vista de detalle. */
export function buildTripDetail(
  trip: TripReply,
  driver: DriverReply | null,
  aggregate: AggregateReply | null,
  vehicle: VehicleReply | null,
  tipCents = 0,
  myRatingStars: number | null = null,
): TripDetailView {
  return {
    id: trip.id,
    status: toTripStatus(trip.status),
    passengerId: trip.passengerId,
    fareCents: trip.fareCents,
    currency: trip.currency,
    tipCents,
    distanceMeters: trip.distanceMeters,
    durationSeconds: trip.durationSeconds,
    paymentMethod: trip.paymentMethod,
    childMode: trip.childMode,
    penaltyCents: trip.penaltyCents,
    // proto3 colapsa null→'' en el string: re-mapeamos '' a null para el contrato mobile (nullable).
    passengerClosedAt: trip.passengerClosedAt ? trip.passengerClosedAt : null,
    // Enriquecimiento "Mis Viajes": timestamps reales + puntos {lat,lng} (alineado con TripHistoryItem) +
    // polyline persistida. proto3 manda '' para los opcionales nulos → re-mapeamos a null (null-safe).
    requestedAt: trip.requestedAt,
    completedAt: trip.completedAt || null,
    cancelledAt: trip.cancelledAt || null,
    origin: { lat: trip.originLat, lng: trip.originLng },
    destination: { lat: trip.destinationLat, lng: trip.destinationLng },
    routePolyline: trip.routePolyline || null,
    driver: buildDriverView(driver, aggregate),
    vehicle: buildVehicleView(vehicle),
    myRatingStars,
  };
}

/** Vista del estado del viaje (polling ligero). */
export function buildTripState(state: TripStateReply): TripStateView {
  return { id: state.id, status: toTripStatus(state.status) };
}

/**
 * Mapea un item gRPC del historial a la vista mobile. Normaliza el status crudo del downstream
 * (CANCELLED_BY_* → CANCELLED, igual que el detalle) y re-mapea los '' de proto3 a null. NO hace ningún
 * lookup extra (anti-N+1): el nombre del conductor lo resuelve el detalle.
 */
export function buildTripHistoryItem(it: TripHistoryItemReply): TripHistoryItemView {
  return {
    id: it.id,
    status: toTripStatus(it.status),
    origin: { lat: it.originLat, lng: it.originLng },
    destination: { lat: it.destinationLat, lng: it.destinationLng },
    fareCents: it.fareCents,
    currency: it.currency,
    paymentMethod: it.paymentMethod,
    distanceMeters: it.distanceMeters,
    durationSeconds: it.durationSeconds,
    requestedAt: it.requestedAt,
    // proto3 '' → null en los opcionales.
    completedAt: it.completedAt || null,
    cancelledAt: it.cancelledAt || null,
    driverId: it.driverId || null,
    vehicleType: it.vehicleType,
    category: it.category || null,
  };
}

/** Mapea la página gRPC del historial a la vista mobile (items + nextCursor; '' → null). */
export function buildTripHistoryPage(reply: PassengerTripsReply): TripHistoryPageView {
  return {
    items: reply.items.map(buildTripHistoryItem),
    nextCursor: reply.nextCursor || null,
  };
}
