/**
 * Mappers OPS: registros del read-model / replies gRPC → vistas públicas de @veo/api-client.
 */
import type { TripSummary, DriverSummary, DriverApproval, TripStatus } from '@veo/api-client';
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

/**
 * Registro del read-model → vista de APROBACIÓN del contrato. fullName/phone no viven en el read-model
 * (vienen de identity) → null honesto; el enriquecimiento por identity es follow-up. `submittedAt` se
 * aproxima con `updatedAt` (última señal del registro). El contrato exige las claves presentes (nullable).
 */
export function driverRecordToApproval(r: DriverRecord): DriverApproval {
  return {
    ...driverRecordToSummary(r),
    fullName: null,
    phone: null,
    submittedAt: r.updatedAt,
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
