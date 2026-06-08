/**
 * Reglas de dominio puras de documentos de flota (BR-I04). Sin I/O ni dependencias de Nest:
 * funciones puras y deterministas → 100% testeables. La capa de servicio/cron las orquesta.
 */
import { FleetDocumentStatus, FleetDocumentType } from '@veo/shared-types';

const MS_PER_DAY = 86_400_000;

/** Estado derivable del vencimiento (lo recalcula el cron). El resto es revisión manual. */
export type ExpiryStatus = Extract<
  FleetDocumentStatus,
  'VALID' | 'EXPIRING_SOON' | 'EXPIRED'
>;

/** Documentos críticos: si vencen, el conductor se suspende (BR-I04). */
export const CRITICAL_DOCUMENT_TYPES: readonly FleetDocumentType[] = [
  FleetDocumentType.LICENSE_A1,
  FleetDocumentType.SOAT,
  FleetDocumentType.PROPERTY_CARD,
];

/** Estados cuyo valor se deriva del vencimiento; PENDING_REVIEW y REJECTED son manuales. */
export const EXPIRY_TRACKED_STATUSES: readonly FleetDocumentStatus[] = [
  FleetDocumentStatus.VALID,
  FleetDocumentStatus.EXPIRING_SOON,
  FleetDocumentStatus.EXPIRED,
];

export function isCriticalDocument(type: FleetDocumentType): boolean {
  return CRITICAL_DOCUMENT_TYPES.includes(type);
}

export function isExpiryTracked(status: FleetDocumentStatus): boolean {
  return EXPIRY_TRACKED_STATUSES.includes(status);
}

/** Días (fraccionarios) hasta el vencimiento. Negativo si ya pasó. */
export function daysUntil(expiresAt: Date, now: Date): number {
  return (expiresAt.getTime() - now.getTime()) / MS_PER_DAY;
}

/** Días restantes redondeados hacia arriba (para alinear los hitos de alerta con el cron diario). */
export function daysUntilCeil(expiresAt: Date, now: Date): number {
  return Math.ceil(daysUntil(expiresAt, now));
}

/**
 * BR-I04: estado del documento derivado de `expiresAt`.
 * - sin vencimiento (p.ej. antecedentes aprobados) → VALID
 * - vencido (instante pasado) → EXPIRED
 * - faltan ≤ warningDays → EXPIRING_SOON
 * - en otro caso → VALID
 * Frontera: exactamente `warningDays` días → EXPIRING_SOON; exactamente 0 días (aún no pasa) → EXPIRING_SOON.
 */
export function deriveExpiryStatus(
  expiresAt: Date | null | undefined,
  now: Date,
  warningDays = 30,
): ExpiryStatus {
  if (!expiresAt) return FleetDocumentStatus.VALID;
  const remaining = daysUntil(expiresAt, now);
  if (remaining < 0) return FleetDocumentStatus.EXPIRED;
  if (remaining <= warningDays) return FleetDocumentStatus.EXPIRING_SOON;
  return FleetDocumentStatus.VALID;
}

/**
 * Hito de alerta vigente para `daysRemaining` dado el set de hitos (30/15/7/1).
 * Devuelve el hito más ajustado (menor) ya alcanzado, o null si aún no entra en ninguno o ya venció.
 */
export function dueExpiryMilestone(daysRemaining: number, milestones: readonly number[]): number | null {
  if (daysRemaining <= 0) return null;
  const reached = milestones.filter((m) => daysRemaining <= m);
  if (reached.length === 0) return null;
  return Math.min(...reached);
}

export interface ExpiryAlertInput {
  expiresAt: Date | null | undefined;
  now: Date;
  milestones: readonly number[];
  /** Último hito (en días) ya alertado para este documento; evita duplicar. */
  alreadyAlertedDays: number | null;
}

/**
 * BR-I04 alertas: decide si hoy corresponde emitir una alerta de vencimiento y a qué hito.
 * Cada hito se alerta una sola vez (se memoriza `alreadyAlertedDays`). Devuelve el hito o null.
 */
export function computeExpiryAlert(input: ExpiryAlertInput): number | null {
  if (!input.expiresAt) return null;
  const milestone = dueExpiryMilestone(daysUntilCeil(input.expiresAt, input.now), input.milestones);
  if (milestone === null) return null;
  // Ya alertamos este hito (o uno más ajustado): no repetir.
  if (input.alreadyAlertedDays !== null && input.alreadyAlertedDays <= milestone) return null;
  return milestone;
}

/**
 * BR-I04 suspensión: hay que suspender al conductor si alguno de sus documentos críticos está EXPIRED.
 */
export function shouldSuspendDriver(
  docs: readonly { type: FleetDocumentType; status: FleetDocumentStatus }[],
): boolean {
  return docs.some((d) => isCriticalDocument(d.type) && d.status === FleetDocumentStatus.EXPIRED);
}
