/**
 * Construcción pura de la vista de seguimiento familiar (familyTrackingView de @veo/api-client).
 * Agrega: enlace (share) + estado del viaje + conductor/vehículo + ubicación + ETA/ruta.
 * Sin I/O: el servicio resuelve las piezas (gRPC/REST/maps) y aquí se ensamblan y validan.
 */
import {
  familyTrackingView,
  tripStatus,
  type FamilyTrackingView,
  type GeoPoint,
  type TripStatus,
} from '@veo/api-client';
import type { AggregateReply, DriverReply, VehicleReply } from '../infra/grpc-types';
import { DOMAIN_STATUS_ALIASES } from '../trips/trip-views';

/**
 * Normaliza el estado; si es desconocido (snapshot sin estado), cae a REQUESTED para no romper la página.
 * Aplica el mismo alias dominio→mobile que `toTripStatus` (CANCELLED_BY_* → CANCELLED): sin esto, un viaje
 * cancelado caía al fallback REQUESTED y la familia veía "buscando conductor" en vez de "cancelado".
 */
export function safeTripStatus(...candidates: (string | null | undefined)[]): TripStatus {
  for (const raw of candidates) {
    if (!raw) continue;
    const parsed = tripStatus.safeParse(DOMAIN_STATUS_ALIASES[raw] ?? raw);
    if (parsed.success) return parsed.data;
  }
  return 'REQUESTED';
}

/**
 * SEGURIDAD-CRÍTICA · pánico oculto (VEO_SPEC_FAMILIA).
 *
 * Marcador de estado que share-service escribe en el read-model del viaje cuando consume
 * `panic.triggered` (ver trip-snapshot.service `onPanic`). NO es un `TripStatus` válido: viaja como
 * crudo en `ShareTrackingDownstream.status`. La vista familiar NUNCA debe revelarlo ni filtrar datos
 * en vivo mientras esté activo, porque un agresor podría estar mirando el enlace.
 */
export const PANIC_STATUS = 'PANIC' as const;

/**
 * Estado benigno con el que se enmascara un viaje en pánico ante la familia: un viaje TERMINADO.
 * Es comportamiento de spec intencional (no es dato falso): si hay —o podría haber— pánico, la página
 * degrada a un estado no-vivo inocuo y deja de servir ubicación/estado/video en vivo (fail-safe = ocultar).
 */
export const PANIC_MASK_STATUS: TripStatus = 'COMPLETED';

/**
 * ¿Hay (o podría haber) un pánico activo para este viaje? Fail-safe = ocultar: cualquier candidato de
 * estado igual a `PANIC` (case-insensitive, con espacios) cuenta como pánico. Se evalúa ANTES de
 * `safeTripStatus` para que ningún estado en vivo de otra fuente (p.ej. trip-service `IN_PROGRESS`)
 * pueda ganarle y filtrar seguimiento en vivo.
 */
export function isPanicActive(...candidates: (string | null | undefined)[]): boolean {
  for (const raw of candidates) {
    if (!raw) continue;
    if (raw.trim().toUpperCase() === PANIC_STATUS) return true;
  }
  return false;
}

export interface FamilyDriverView {
  name: string;
  rating: number | null;
  vehiclePlate: string | null;
  vehicleModel: string | null;
  vehicleColor: string | null;
}

/**
 * Vista de conductor para la familia. El nombre viene de `DriverReply.name` (identity, vía la relación
 * driver→user). Para la familia es SEGURIDAD mostrar quién maneja (mismo chequeo que ve el pasajero): el
 * pasajero compartió el viaje justamente para que su familia verifique al conductor. `''` (default proto3,
 * o conductor sin nombre) se normaliza a cadena vacía — el contrato exige string no-null; la UI degrada a
 * "Conductor" honesto si llega vacío.
 */
export function buildFamilyDriver(
  driver: DriverReply | null,
  aggregate: AggregateReply | null,
  vehicle: VehicleReply | null,
): FamilyDriverView | null {
  if (!driver && !vehicle) return null;
  const rating =
    aggregate && aggregate.count30d > 0
      ? aggregate.rollingAvg30d
      : driver && driver.averageRating > 0
        ? driver.averageRating
        : null;
  return {
    name: driver?.name?.trim() ?? '',
    rating,
    vehiclePlate: vehicle?.plate ?? null,
    vehicleModel: vehicle ? `${vehicle.make} ${vehicle.model}`.trim() : null,
    vehicleColor: vehicle?.color ?? null,
  };
}

export interface AssembleFamilyViewInput {
  tripId: string;
  status: TripStatus;
  origin: GeoPoint | null;
  destination: GeoPoint | null;
  driverLocation: GeoPoint | null;
  driver: FamilyDriverView | null;
  etaSeconds: number | null;
  routePolyline: string | null;
  expiresAt: string;
  revoked: boolean;
}

/**
 * SEGURIDAD-CRÍTICA · vista familiar ENMASCARADA durante pánico (VEO_SPEC_FAMILIA).
 *
 * Devuelve un estado benigno de viaje TERMINADO: SIN ubicación en vivo, SIN conductor/vehículo, SIN
 * ETA/ruta y SIN filtrar el estado real. `revoked` se deja en false a propósito para que la página se
 * vea como un viaje normal ya finalizado y no como un enlace cortado (que podría delatar algo). El video
 * se deniega aparte en `videoGrant`. NO se inventan datos: ocultar es el comportamiento de spec.
 *
 * `tripId` se conserva (no es dato sensible y el enlace ya lo expone); todo lo demás se vacía.
 */
export function assembleMaskedPanicView(tripId: string, expiresAt: string): FamilyTrackingView {
  return assembleFamilyView({
    tripId,
    status: PANIC_MASK_STATUS,
    origin: null,
    destination: null,
    driverLocation: null,
    driver: null,
    etaSeconds: null,
    routePolyline: null,
    expiresAt,
    revoked: false,
  });
}

/** Ensambla y valida la vista contra el contrato compartido familyTrackingView. */
export function assembleFamilyView(input: AssembleFamilyViewInput): FamilyTrackingView {
  return familyTrackingView.parse({
    tripId: input.tripId,
    status: input.status,
    passengerName: null,
    origin: input.origin,
    destination: input.destination,
    driverLocation: input.driverLocation,
    etaSeconds: input.etaSeconds,
    driver: input.driver,
    routePolyline: input.routePolyline,
    expiresAt: input.expiresAt,
    revoked: input.revoked,
  } satisfies FamilyTrackingView);
}
