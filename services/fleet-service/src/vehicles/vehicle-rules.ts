/**
 * Reglas de dominio puras del vehículo (BR-D04). Funciones puras, sin I/O.
 */
import { FleetDocumentType } from '@veo/shared-types';
import { VehicleDocStatus } from '../generated/prisma';
import type { ExpiryStatus } from '../documents/document-rules';

/** BR-D04: el vehículo debe ser del año mínimo en adelante (por defecto 2017). */
export function isVehicleYearEligible(year: number, minYear = 2017): boolean {
  return Number.isInteger(year) && year >= minYear;
}

/**
 * Estado de revisión del vehículo derivado de `active`. El alta self-service del conductor
 * entra como `active=false` (pendiente de verificación del operador). No persiste columna nueva:
 * se deriva de los campos existentes para mantener una única fuente de verdad.
 */
export const VehicleReviewStatus = {
  PENDING_REVIEW: 'PENDING_REVIEW',
  ACTIVE: 'ACTIVE',
} as const;
export type VehicleReviewStatus = (typeof VehicleReviewStatus)[keyof typeof VehicleReviewStatus];

/** Deriva el estado de revisión: ACTIVE si el vehículo está activo, PENDING_REVIEW si no. */
export function deriveVehicleReviewStatus(vehicle: { active: boolean }): VehicleReviewStatus {
  return vehicle.active ? VehicleReviewStatus.ACTIVE : VehicleReviewStatus.PENDING_REVIEW;
}

/** Campos que deciden cuál es el vehículo ACTIVO (operado) del conductor. */
export interface ActiveVehicleCandidate {
  docStatus: VehicleDocStatus;
  selectedAt: Date | null;
  createdAt: Date;
}

/**
 * Elige el vehículo ACTIVO del conductor entre los suyos (regla server-authoritative del tipo operado):
 * el de `selectedAt` MÁS RECIENTE con docs vigentes (docStatus != EXPIRED); si ninguno fue seleccionado,
 * el más recientemente registrado. `null` si no tiene ninguno OPERABLE (todos con docs vencidos, o sin
 * vehículos). NO gatea por `active` (aprobación del operador): no existe workflow de aprobación todavía,
 * gatear ahí dejaría a todos sin operar (degradación honesta) — el gate real es: registrado + docs vigentes.
 */
export function pickActiveVehicle<T extends ActiveVehicleCandidate>(
  vehicles: readonly T[],
): T | null {
  const operable = vehicles.filter((v) => v.docStatus !== VehicleDocStatus.EXPIRED);
  if (operable.length === 0) return null;
  return operable.reduce((best, v) => {
    const bestKey = best.selectedAt?.getTime() ?? -1;
    const vKey = v.selectedAt?.getTime() ?? -1;
    if (vKey !== bestKey) return vKey > bestKey ? v : best;
    // Desempate (ninguno seleccionado, o mismo instante): el más recientemente registrado.
    return v.createdAt.getTime() > best.createdAt.getTime() ? v : best;
  });
}

/** Documentos del vehículo que cuentan para su estado documental agregado (BR-D04: SOAT e ITV). */
export const VEHICLE_REQUIRED_DOCUMENT_TYPES: readonly FleetDocumentType[] = [
  FleetDocumentType.SOAT,
  FleetDocumentType.ITV,
];

const SEVERITY: Record<ExpiryStatus, number> = {
  VALID: 0,
  EXPIRING_SOON: 1,
  EXPIRED: 2,
};

const TO_VEHICLE_STATUS: Record<ExpiryStatus, VehicleDocStatus> = {
  VALID: VehicleDocStatus.VALID,
  EXPIRING_SOON: VehicleDocStatus.EXPIRING_SOON,
  EXPIRED: VehicleDocStatus.EXPIRED,
};

/**
 * Estado documental agregado del vehículo: el peor estado entre sus documentos relevantes y el seguro.
 * Sin entradas → VALID.
 */
export function aggregateVehicleDocStatus(statuses: readonly ExpiryStatus[]): VehicleDocStatus {
  let worst: ExpiryStatus = 'VALID';
  for (const s of statuses) {
    if (SEVERITY[s] > SEVERITY[worst]) worst = s;
  }
  return TO_VEHICLE_STATUS[worst];
}
