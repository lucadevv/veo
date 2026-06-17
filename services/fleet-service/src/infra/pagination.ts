/**
 * Paginación por cursor para fleet-service. Los ids son uuidv7 (time-ordered), así que ordenar por
 * `id desc` da "más nuevos primero" y el cursor es simplemente el último id de la página anterior
 * (sin offset costoso). Convención compartida por vehicles/documents/inspections.
 */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** Normaliza el límite a [1, MAX_LIMIT] con default sano. */
export function clampLimit(limit?: number): number {
  if (limit === undefined || Number.isNaN(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

/**
 * Convierte el resultado de un `findMany({ take: limit + 1 })` en una página: si vinieron más de
 * `limit` filas, hay siguiente página y el cursor es el id de la última fila devuelta.
 */
export function toPage<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? last.id : null };
}
