/**
 * Reglas de dominio puras de inspecciones técnicas (BR-D04). Funciones puras, sin I/O.
 */

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
