/**
 * Mappers OPS: registros del read-model / replies gRPC → vistas públicas de @veo/api-client.
 */
import type { TripSummary, DriverSummary, TripStatus } from '@veo/api-client';
import type { TripRecord, DriverRecord } from '../read-model/read-model.service';

export function tripRecordToSummary(r: TripRecord): TripSummary {
  return {
    id: r.id,
    status: r.status,
    passengerId: r.passengerId,
    driverId: r.driverId,
    fareCents: r.fareCents,
    createdAt: r.createdAt,
  };
}

export function driverRecordToSummary(r: DriverRecord): DriverSummary {
  return {
    id: r.id,
    userId: r.userId,
    status: r.status,
    averageRating: r.averageRating,
    backgroundCheckStatus: r.backgroundCheckStatus,
  };
}

/** Normaliza el estado de trip-service (@veo/shared-types) al enum de la vista (@veo/api-client). */
export function mapTripStatus(raw: string): TripStatus {
  switch (raw) {
    case 'REQUESTED':
    case 'ASSIGNED':
    case 'ACCEPTED':
    case 'ARRIVING':
    case 'ARRIVED':
    case 'IN_PROGRESS':
    case 'COMPLETED':
      return raw;
    case 'CANCELLED_BY_PASSENGER':
    case 'CANCELLED_BY_DRIVER':
    case 'EXPIRED':
    case 'FAILED':
      return 'CANCELLED';
    default:
      return 'REQUESTED';
  }
}
