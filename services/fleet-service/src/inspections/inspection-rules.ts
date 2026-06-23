/**
 * Reglas de dominio puras de inspecciones técnicas (BR-D04). Funciones puras, sin I/O.
 */
import { ValidationError } from '@veo/utils';

/**
 * ANTI-FUTURO (compliance · gate auto-atestable): una inspección NO puede ser del futuro. Un `inspectedAt`
 * fabricado hacia adelante produce un `nextDueAt` futuro que gana el `orderBy inspectedAt desc` y superaría
 * por fecha a una inspección REAL reprobada/vencida, dejando pasar el gate de ITV. Tope duro: lanza
 * `ValidationError` tipado si `inspectedAt > now`. El operador no puede registrar una ITV "del mañana".
 */
export function assertInspectedAtNotFuture(inspectedAt: Date, now: Date): void {
  if (inspectedAt.getTime() > now.getTime()) {
    throw new ValidationError('La fecha de inspección no puede ser futura', {
      inspectedAt: inspectedAt.toISOString(),
      now: now.toISOString(),
    });
  }
}

/**
 * BR-D04: la inspección técnica es trimestral. La próxima vence `intervalMonths` meses
 * después de la inspección (por defecto 3). Usa aritmética de calendario (no 90 días fijos).
 */
export function computeNextInspectionDue(inspectedAt: Date, intervalMonths = 3): Date {
  const next = new Date(inspectedAt.getTime());
  next.setMonth(next.getMonth() + intervalMonths);
  return next;
}

/** ¿La inspección está vencida a la fecha `now`? (nextDueAt ya pasó). */
export function isInspectionOverdue(nextDueAt: Date, now: Date): boolean {
  return nextDueAt.getTime() < now.getTime();
}

/** Campos de una inspección que deciden su vigencia (forma mínima, desacoplada de Prisma). */
export interface InspectionLike {
  passed: boolean;
  nextDueAt: Date;
}

/**
 * VIGENCIA de la inspección técnica (ITV): vale para operar SOLO si la última pasó (`passed`) y NO está
 * vencida (`nextDueAt > now`). Una inspección reprobada o vencida NO habilita. `null` (sin inspección) =
 * NO vigente — un vehículo sin ITV jamás se considera inspeccionado.
 */
export function isInspectionCurrent(latest: InspectionLike | null, now: Date): boolean {
  if (!latest) return false;
  return latest.passed === true && !isInspectionOverdue(latest.nextDueAt, now);
}

/**
 * Motivo tipado por el que la ITV de un vehículo NO habilita (para un error claro en el gate de aprobación).
 * `NONE` = nunca tuvo inspección; `NOT_PASSED` = la última reprobó; `OVERDUE` = la última está vencida.
 */
export const InspectionInvalidReason = {
  NONE: 'NONE',
  NOT_PASSED: 'NOT_PASSED',
  OVERDUE: 'OVERDUE',
} as const;
export type InspectionInvalidReason =
  (typeof InspectionInvalidReason)[keyof typeof InspectionInvalidReason];

/**
 * Clasifica POR QUÉ la ITV no es vigente. `null` cuando SÍ es vigente (no hay motivo de invalidez).
 * Precedencia: sin inspección → NONE; reprobada → NOT_PASSED; vencida → OVERDUE.
 */
export function inspectionInvalidReason(
  latest: InspectionLike | null,
  now: Date,
): InspectionInvalidReason | null {
  if (!latest) return InspectionInvalidReason.NONE;
  if (latest.passed !== true) return InspectionInvalidReason.NOT_PASSED;
  if (isInspectionOverdue(latest.nextDueAt, now)) return InspectionInvalidReason.OVERDUE;
  return null;
}
