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

/**
 * Cursor COMPUESTO para órdenes (expiresAt asc, id asc). El resto de las listas (vehicles/documents/
 * inspections) ordenan por `id` solo → su cursor es el id (toPage). La cola de vencimientos ordena por
 * PROXIMIDAD de vencimiento, así que el id solo NO basta: filas con distinto expiresAt no quedan
 * resueltas por un keyset de id. El cursor codifica la TUPLA `(expiresAt, id)` para resumir el keyset
 * sin saltear ni duplicar. Separador `|`: el id es uuidv7 (sin `|`) y la fecha va en ISO (sin `|`).
 */
const CURSOR_SEP = '|';

/** Serializa el cursor compuesto a partir de la última fila de la página (expiresAt ISO + id). */
export function encodeExpiryCursor(row: { expiresAt: Date | null; id: string }): string {
  // En la cola de vencimientos `expiresAt` nunca es null (el where filtra `not: null`); el `?? ''` es
  // una guarda defensiva para no romper el formato si el invariante cambiara.
  return `${row.expiresAt ? row.expiresAt.toISOString() : ''}${CURSOR_SEP}${row.id}`;
}

/** Deserializa el cursor compuesto a `{ expiresAt, id }`. Devuelve null si el formato no es válido. */
export function decodeExpiryCursor(cursor: string): { expiresAt: Date; id: string } | null {
  const sep = cursor.indexOf(CURSOR_SEP);
  if (sep <= 0 || sep === cursor.length - 1) return null;
  const expiresAt = new Date(cursor.slice(0, sep));
  const id = cursor.slice(sep + 1);
  if (Number.isNaN(expiresAt.getTime()) || id.length === 0) return null;
  return { expiresAt, id };
}

/**
 * Variante de `toPage` para listas con cursor compuesto: el `nextCursor` se deriva de la tupla
 * (expiresAt, id) de la última fila devuelta, no del id solo.
 */
export function toExpiryPage<T extends { id: string; expiresAt: Date | null }>(
  rows: T[],
  limit: number,
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: hasMore && last ? encodeExpiryCursor(last) : null };
}
