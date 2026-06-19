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
import type { AdminRole } from '@veo/shared-types';
import type { TripRecord, DriverRecord } from '../read-model/read-model.service';
import { canSeeIdentity } from '../redaction/redaction.policy';

/**
 * `fareCents` es `number` NO-nullable en el contrato (`tripSummary`/`tripDetail` de @veo/api-client).
 * La matriz aprobada manda redactar montos a `null` para roles sin permiso financiero, pero hacerlo
 * acá rompería el contrato (toca @veo/api-client + UI admin-web). Por eso la redacción de MONTOS en
 * /ops/trips queda DIFERIDA (identidad es la prioridad de este lote); ver reporte. `roles` se acepta
 * ya en la firma para no re-tocar call-sites cuando el contrato se haga nullable.
 */
export function tripRecordToSummary(r: TripRecord, _roles: readonly AdminRole[]): TripSummary {
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
export function driverRecordToApproval(
  r: DriverRecord,
  roles: readonly AdminRole[],
  identity?: { fullName: string | null; phone: string | null },
): DriverApproval {
  // IDENTIDAD (fullName/phone) = Compliance+. El admin-bff enriquece la página con identity (lectura
  // BATCH, sin N+1) SOLO cuando el rol puede verla; sub-Compliance recibe `null` (redacción server-side,
  // la UI no decide). Los eventos driver.* NO llevan PII (Ley 29733) → la identidad NO vive en el
  // read-model, se resuelve on-read contra identity. NUNCA se inventa data: sin enriquecimiento → null.
  const identityVisible = canSeeIdentity(roles);
  return {
    ...driverRecordToSummary(r),
    fullName: identityVisible ? identity?.fullName ?? null : null,
    phone: identityVisible ? identity?.phone ?? null : null,
    submittedAt: r.updatedAt,
    // Motivo del último rechazo (proyectado del evento driver.rejected); null si no está rechazado.
    rejectionReason: r.rejectionReason,
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
