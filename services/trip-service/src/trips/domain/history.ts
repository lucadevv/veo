/**
 * Historial paginado del pasajero (lado dominio, PURO · sin I/O). Define:
 *  - el item de la card del historial (TripHistoryItem),
 *  - el codec del CURSOR opaco (keyset por requestedAt+id), y
 *  - el helper que arma el `where`/`orderBy`/`take` del findMany para la paginación keyset.
 *
 * DECISIÓN · paginación por CURSOR (keyset), no offset:
 *   - El offset (limit/offset) degrada a escala: Postgres lee y DESCARTA las N filas saltadas, y si
 *     entran viajes nuevos entre páginas las filas se desplazan (se repiten o se pierden).
 *   - El keyset por (requestedAt DESC, id DESC) es estable e indexado por @@index([passengerId,
 *     requestedAt, id]): cada página arranca EXACTO donde terminó la anterior, sin descartes.
 *
 * DECISIÓN · anti-N+1 en la lista:
 *   El item NO trae el nombre del conductor (solo driverId). Resolver el nombre por-item sería un gRPC
 *   a identity por fila (N+1). La card muestra tier+ruta+monto+estado; el NOMBRE del conductor lo
 *   resuelve el DETALLE (GetTrip, ya existente) on-demand cuando el pasajero abre un viaje.
 */
import type { Trip } from '../../generated/prisma';

/** Tope duro del tamaño de página (anti-DoS: un cliente no puede pedir 10k de una). */
export const MAX_HISTORY_PAGE = 50;
/** Tamaño de página por defecto si el cliente no pide uno (o pide 0). */
export const DEFAULT_HISTORY_PAGE = 20;

/** Un viaje en el historial del pasajero (subconjunto de TripView pensado para la card + detalle). */
export interface TripHistoryItem {
  id: string;
  status: string;
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  fareCents: number;
  currency: string;
  paymentMethod: string;
  distanceMeters: number;
  durationSeconds: number;
  /** ISO-8601, siempre presente. */
  requestedAt: string;
  /** ISO-8601 o null si el viaje no llegó a COMPLETED. */
  completedAt: string | null;
  /** ISO-8601 o null si el viaje no fue cancelado. */
  cancelledAt: string | null;
  /** null si el viaje nunca tuvo conductor (EXPIRED/REQUESTED). La app resuelve el nombre en el detalle. */
  driverId: string | null;
  /** Tier (CAR|MOTO). */
  vehicleType: string;
  /** Categoría/opción elegida (quoteOption.id); null si no se eligió. */
  category: string | null;
}

/** Página del historial: items + cursor de la siguiente página (null si no hay más). */
export interface TripHistoryPage {
  items: TripHistoryItem[];
  nextCursor: string | null;
}

/** Clave keyset: el viaje (requestedAt, id) desde el que continúa la SIGUIENTE página. */
export interface HistoryCursor {
  requestedAt: string;
  id: string;
}

/**
 * Acota el `limit` pedido a [1, MAX_HISTORY_PAGE]. 0/undefined/negativo → DEFAULT_HISTORY_PAGE.
 * El servidor SIEMPRE manda en el tamaño de página (el cliente no puede forzar páginas enormes).
 */
export function clampLimit(limit?: number): number {
  if (!limit || limit <= 0) return DEFAULT_HISTORY_PAGE;
  return Math.min(Math.floor(limit), MAX_HISTORY_PAGE);
}

/**
 * Codifica el cursor a un string OPACO (base64url de "requestedAt|id"). Opaco a propósito: el cliente
 * lo trata como token, no parsea su interior (podemos cambiar el esquema sin romper la app).
 */
export function encodeCursor(c: HistoryCursor): string {
  return Buffer.from(`${c.requestedAt}|${c.id}`, 'utf8').toString('base64url');
}

/**
 * Decodifica el cursor opaco. Devuelve null si es inválido/malformado (el caller trata "cursor basura"
 * como "primera página" en vez de reventar: un cursor viejo/corrupto no debe tirar 500).
 */
export function decodeCursor(raw: string | undefined | null): HistoryCursor | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const sep = decoded.indexOf('|');
    if (sep <= 0) return null;
    const requestedAt = decoded.slice(0, sep);
    const id = decoded.slice(sep + 1);
    if (!id || Number.isNaN(Date.parse(requestedAt))) return null;
    return { requestedAt, id };
  } catch {
    return null;
  }
}

/**
 * Arma el `where` del findMany para la página keyset. Orden (requestedAt DESC, id DESC): la condición de
 * "después del cursor" (más viejo que el último visto) es
 *   requestedAt < cursor.requestedAt OR (requestedAt = cursor.requestedAt AND id < cursor.id)
 * Sin cursor → solo el filtro por pasajero (primera página).
 */
export function historyWhere(
  passengerId: string,
  cursor: HistoryCursor | null,
): Record<string, unknown> {
  if (!cursor) return { passengerId };
  const at = new Date(cursor.requestedAt);
  return {
    passengerId,
    OR: [{ requestedAt: { lt: at } }, { requestedAt: at, id: { lt: cursor.id } }],
  };
}

/**
 * Espejo de `historyWhere` para el historial del CONDUCTOR: mismo comparador keyset (requestedAt DESC,
 * id DESC) pero filtrando por `driverId` (id de PERFIL Driver de identity, NO userId). Sin cursor → solo
 * el filtro por conductor (primera página). El driverId lo FIJA el BFF desde el JWT (anti-IDOR): un viaje
 * de OTRO conductor NUNCA aparece porque el `where` siempre lleva driverId.
 */
export function driverHistoryWhere(
  driverId: string,
  cursor: HistoryCursor | null,
): Record<string, unknown> {
  if (!cursor) return { driverId };
  const at = new Date(cursor.requestedAt);
  return {
    driverId,
    OR: [{ requestedAt: { lt: at } }, { requestedAt: at, id: { lt: cursor.id } }],
  };
}

/** Mapea una fila Trip al item del historial (ISO-8601, null para sin-valor). */
export function tripToHistoryItem(t: Trip): TripHistoryItem {
  return {
    id: t.id,
    status: t.status,
    origin: { lat: t.originLat, lng: t.originLon },
    destination: { lat: t.destLat, lng: t.destLon },
    fareCents: t.fareCents,
    currency: t.currency,
    paymentMethod: t.paymentMethod,
    distanceMeters: t.distanceMeters,
    durationSeconds: t.durationSeconds,
    requestedAt: t.requestedAt.toISOString(),
    completedAt: t.completedAt ? t.completedAt.toISOString() : null,
    cancelledAt: t.cancelledAt ? t.cancelledAt.toISOString() : null,
    driverId: t.driverId ?? null,
    vehicleType: t.vehicleType,
    category: t.category ?? null,
  };
}
