/**
 * Cálculo puro de la política de retención de video (BR-S03).
 *
 * Reglas:
 *  - Por defecto: 30 días tras el inicio del segmento.
 *  - Viaje con incidente: 180 días.
 *  - Viaje con pánico (panic_event): retención INDEFINIDA hasta su resolución → `null`.
 *
 * `null` significa "no expira por tiempo": el barrido nunca borra estos segmentos hasta que el
 * pánico se resuelva (lo que limpiaría la bandera y recalcularía la retención).
 */
export interface RetentionInput {
  startedAt: Date;
  hasIncident: boolean;
  hasPanic: boolean;
  defaultDays: number;
  incidentDays: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Devuelve la fecha límite de retención, o `null` si es indefinida (pánico). */
export function computeRetentionUntil(input: RetentionInput): Date | null {
  if (input.hasPanic) return null;
  const days = input.hasIncident ? input.incidentDays : input.defaultDays;
  return new Date(input.startedAt.getTime() + days * MS_PER_DAY);
}

/** True si el segmento es elegible para barrido (su retención venció antes de `now`). */
export function isExpired(retentionUntil: Date | null, now: Date): boolean {
  if (retentionUntil === null) return false; // indefinido
  return retentionUntil.getTime() <= now.getTime();
}
