/**
 * Mapeo Trip (fila Prisma) → TripView (DTO de salida). Funciones PURAS, sin estado ni I/O —
 * extraídas de TripsService (SRP: el service orquesta el dominio; el mapeo de vista vive aquí).
 * Mismo patrón que domain/history.ts (tripToHistoryItem) y domain/fare.ts.
 */
import type { LatLon } from '@veo/utils';
import type { Trip } from '../generated/prisma';
import type { TripView } from './dto/trip.dto';

/** Punto geográfico persistido como JSON en `waypoints`. */
interface WaypointJson {
  lat: number;
  lon: number;
}

/** Lee las paradas múltiples (Ola 2B) persistidas como JSON; [] si el viaje es directo. */
export function readWaypoints(trip: Trip): LatLon[] {
  const raw = trip.waypoints;
  if (!Array.isArray(raw)) return [];
  return (raw as unknown as WaypointJson[]).map((w) => ({ lat: w.lat, lon: w.lon }));
}

/** Serializa una fila Trip a la vista pública (fechas ISO, null explícito para sin-valor). */
export function toTripView(trip: Trip): TripView {
  return {
    id: trip.id,
    passengerId: trip.passengerId,
    driverId: trip.driverId,
    vehicleId: trip.vehicleId,
    status: trip.status,
    origin: { lat: trip.originLat, lon: trip.originLon },
    destination: { lat: trip.destLat, lon: trip.destLon },
    waypoints: readWaypoints(trip),
    fareCents: trip.fareCents,
    currency: trip.currency,
    surgeMultiplier: Number(trip.surgeMultiplier.toString()),
    distanceMeters: trip.distanceMeters,
    durationSeconds: trip.durationSeconds,
    paymentMethod: trip.paymentMethod,
    routePolyline: trip.routePolyline,
    category: trip.category,
    vehicleType: trip.vehicleType,
    // S1 (ADR 011) — el modo CONGELADO del viaje viaja en la vista: createTrip + GET trip lo exponen
    // para que la app reconcilie contra lo que mostró el quote (un flip entre quote y create se detecta).
    dispatchMode: trip.dispatchMode,
    scheduledFor: trip.scheduledFor ? trip.scheduledFor.toISOString() : null,
    childMode: trip.childMode,
    specialRequests: trip.specialRequests,
    penaltyCents: trip.penaltyCents,
    requestedAt: trip.requestedAt.toISOString(),
    completedAt: trip.completedAt ? trip.completedAt.toISOString() : null,
    cancelledAt: trip.cancelledAt ? trip.cancelledAt.toISOString() : null,
    // Re-entrada del cierre: marca de cuándo el pasajero cerró el post-viaje; null = aún sin cerrar.
    passengerClosedAt: trip.passengerClosedAt ? trip.passengerClosedAt.toISOString() : null,
  };
}
