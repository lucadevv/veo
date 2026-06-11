/**
 * Mappers OPS: registros del read-model / replies gRPC → vistas públicas de @veo/api-client.
 */
import {
  normalizeTripStatus,
  type AdminTripStatus,
  type DriverApproval,
  type DriverSummary,
  type TripStatus,
  type TripSummary,
} from '@veo/api-client';
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

/**
 * Vista OPS de cada estado del contrato — EXHAUSTIVO: agregar un `TripStatus` nuevo sin decidir su
 * cara admin es error de COMPILACIÓN (el Record exige cubrir cada clave), no un default mudo.
 * Hoy es identidad porque el contrato admin ya expresa todos los estados de forma honesta —
 * en particular REASSIGNING (pasajero abandonado, ops DEBE intervenir), SCHEDULED, EXPIRED y
 * FAILED, que el switch anterior disfrazaba de REQUESTED/CANCELLED.
 */
const ADMIN_TRIP_STATUS: Record<TripStatus, AdminTripStatus> = {
  SCHEDULED: 'SCHEDULED',
  REQUESTED: 'REQUESTED',
  MATCHING: 'MATCHING',
  ASSIGNED: 'ASSIGNED',
  ACCEPTED: 'ACCEPTED',
  ARRIVING: 'ARRIVING',
  ARRIVED: 'ARRIVED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  REASSIGNING: 'REASSIGNING',
  EXPIRED: 'EXPIRED',
  FAILED: 'FAILED',
};

/**
 * Normaliza el estado CRUDO de trip-service al enum de la vista OPS (@veo/api-client).
 * `normalizeTripStatus` resuelve los alias del dominio (CANCELLED_BY_* → CANCELLED) y valida contra
 * el contrato; un valor fuera del contrato se reporta como UNKNOWN honesto (visible para ops),
 * nunca como un REQUESTED falso.
 */
export function mapTripStatus(raw: string): AdminTripStatus {
  const normalized = normalizeTripStatus(raw);
  return normalized === null ? 'UNKNOWN' : ADMIN_TRIP_STATUS[normalized];
}
