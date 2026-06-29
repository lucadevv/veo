/**
 * Reglas de dominio puras del vehículo (BR-D04). Funciones puras, sin I/O.
 */
import { FleetDocumentType, FleetDocumentStatus } from '@veo/shared-types';
import { VehicleDocStatus } from '../generated/prisma';
import { isDocumentValid, type ExpiryStatus } from '../documents/document-rules';

/** BR-D04: el vehículo debe ser del año mínimo en adelante (por defecto 2017). */
export function isVehicleYearEligible(year: number, minYear = 2017): boolean {
  return Number.isInteger(year) && year >= minYear;
}

/**
 * Estado de revisión / OPERABILIDAD del vehículo. Una única fuente de verdad DERIVADA de señales reales
 * (no de un flag estático que nunca se flipea).
 */
export const VehicleReviewStatus = {
  PENDING_REVIEW: 'PENDING_REVIEW',
  ACTIVE: 'ACTIVE',
} as const;
export type VehicleReviewStatus = (typeof VehicleReviewStatus)[keyof typeof VehicleReviewStatus];

/**
 * ¿El vehículo tiene TODOS sus documentos REQUERIDOS (SOAT + ITV) presentes, aprobados y vigentes? Pura.
 *
 * Esta es la señal REAL de "el operador verificó el vehículo": cada tipo requerido debe existir con un estado
 * OPERABLE (`isDocumentValid`: VALID/EXPIRING_SOON — aprobado y no vencido). Un documento PENDING_REVIEW (sin
 * revisar), REJECTED o EXPIRED, o un tipo AUSENTE, hacen al vehículo NO operable. OJO: `Vehicle.docStatus`
 * (agregado) NO sirve para esto — nace VALID por default y solo refleja VENCIMIENTO, así que un vehículo SIN
 * documentos da docStatus=VALID (un vehículo sin SOAT/ITV NO puede operar — seguro obligatorio + ITV legales).
 */
export function hasRequiredVehicleDocsOperable(
  docs: readonly { type: FleetDocumentType; status: FleetDocumentStatus }[],
): boolean {
  return VEHICLE_REQUIRED_DOCUMENT_TYPES.every((required) =>
    docs.some((d) => d.type === required && isDocumentValid(d.status)),
  );
}

/**
 * Deriva la OPERABILIDAD del vehículo de señales REALES: ACTIVE cuando sus documentos requeridos están
 * presentes+aprobados+vigentes (`docsOperable`, ver `hasRequiredVehicleDocsOperable`) Y tiene su ficha técnica
 * linkeada (`modelSpecId != null`); si no, PENDING_REVIEW.
 *
 * Por qué DERIVADO y no un flag `active` stored: el alta del conductor nacía `active=false` ("pendiente de
 * verificación del operador") y NINGÚN workflow lo flipeaba a true → el gate de carpool bloqueaba a TODO
 * conductor onboardeado. Pero derivar de `docStatus` era un OVER-UNBLOCK: ese agregado solo mide vencimiento y
 * nace VALID, así que un vehículo SIN SOAT/ITV daba ACTIVE. La señal correcta es la presencia+aprobación REAL
 * de los docs (la "verificación del operador" = doc-review que aprueba cada doc) + la ficha linkeada. Función
 * pura: el caller trae los docs (mismo riel que `validCertificationsOf`) y computa `docsOperable`.
 */
export function deriveVehicleReviewStatus(input: {
  docsOperable: boolean;
  modelSpecId: string | null;
}): VehicleReviewStatus {
  return input.docsOperable && input.modelSpecId !== null
    ? VehicleReviewStatus.ACTIVE
    : VehicleReviewStatus.PENDING_REVIEW;
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
