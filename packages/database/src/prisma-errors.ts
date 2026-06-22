/**
 * Detección TIPADA de errores Prisma, compartida por todos los servicios.
 *
 * GOTCHA (por qué NO `instanceof`): cada servicio genera SU PROPIO cliente Prisma
 * (`output = "../src/generated/prisma"`, con el runtime COPIADO dentro del servicio), así que
 * `Prisma.PrismaClientKnownRequestError` es una CLASE DISTINTA por servicio. Un `instanceof`
 * contra la clase del `@prisma/client` de ESTE paquete nunca matchearía un error lanzado por el
 * cliente generado de un servicio. Se detecta de forma ESTRUCTURAL (`name` + `code`), que el
 * runtime de Prisma 5 fija en el constructor (`this.name = "PrismaClientKnownRequestError"`).
 */

/** Código Prisma de violación de UNIQUE (P2002, "Unique constraint failed"). */
export const PRISMA_UNIQUE_VIOLATION = 'P2002';

/**
 * Código Prisma de "no se encontró el registro a mutar" (P2025, "An operation failed because it depends
 * on one or more records that were required but not found"). Lo lanza `update`/`delete`/`updateMany`-vía-
 * `update` cuando el `where` no matchea NINGUNA fila — el caso canónico de un UPDATE ATÓMICO CONDICIONADO
 * (where con `estado: { in: [...] }`): si la fila cambió de estado en la PRIMARIA, 0 filas matchean → P2025.
 */
export const PRISMA_RECORD_NOT_FOUND = 'P2025';

const PRISMA_KNOWN_REQUEST_ERROR_NAME = 'PrismaClientKnownRequestError';

/**
 * Forma mínima (estructural, válida cross-cliente-generado) de un `PrismaClientKnownRequestError`
 * cuyo código es P2002. `meta.target` trae la(s) columna(s)/constraint del UNIQUE violado.
 */
export interface PrismaUniqueViolationError extends Error {
  code: typeof PRISMA_UNIQUE_VIOLATION;
  meta?: { target?: unknown };
}

/**
 * ¿`err` es una violación de UNIQUE (P2002) de Prisma?
 *
 * - SIN `column`: matchea CUALQUIER unique del modelo (el idiom histórico
 *   `err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'`).
 * - CON `column`: además exige que `meta.target` apunte a esa columna/constraint. Más preciso
 *   cuando el modelo tiene varios UNIQUE y el camino de recuperación (idempotencia/dedup) solo
 *   vale para uno. El matching normaliza camelCase/snake_case porque Prisma reporta a veces el
 *   field (`dedupKey`) y a veces el nombre del constraint (`panic_events_dedup_key_key`).
 * - Si Prisma no reporta `meta.target` fiable, se asume que SÍ matchea (mismo criterio que el
 *   `isDedupConflict` original de panic-service: no romper el camino de idempotencia por falta
 *   de metadata).
 *
 * @example
 * try {
 *   await prisma.write.payment.create({ data });
 * } catch (err) {
 *   if (isUniqueViolation(err, 'dedupKey')) return existingPayment(); // doble-submit → no-op
 *   throw err;
 * }
 */
export function isUniqueViolation(
  err: unknown,
  column?: string,
): err is PrismaUniqueViolationError {
  if (!(err instanceof Error) || err.name !== PRISMA_KNOWN_REQUEST_ERROR_NAME) return false;
  const known = err as Partial<PrismaUniqueViolationError>;
  if (known.code !== PRISMA_UNIQUE_VIOLATION) return false;
  if (column === undefined) return true;
  return targetsColumn(known.meta?.target, column);
}

/**
 * ¿`err` es un P2025 ("record required but not found") de Prisma? Detección ESTRUCTURAL (mismo motivo
 * cross-cliente-generado que `isUniqueViolation`: cada servicio genera su propio runtime → `instanceof`
 * no sirve). Su uso canónico: un UPDATE ATÓMICO CONDICIONADO POR ESTADO (`where: { id, driverId, estado:
 * { in: [...] } }`) que afecta 0 filas porque el estado en la PRIMARIA ya no es válido → Prisma lanza P2025
 * → el repo lo traduce a un ConflictError tipado ("el recurso cambió de estado, recargá"), NUNCA un 500 ni
 * el mensaje interno de Prisma filtrado al cliente. Cierra la ventana TOCTOU sin lock pesimista.
 *
 * @example
 * try {
 *   await tx.publishedTrip.update({ where: { id, driverId, estado: { in: editables } }, data });
 * } catch (err) {
 *   if (isRecordNotFound(err)) throw new ConflictError('el viaje cambió de estado, recargá');
 *   throw err;
 * }
 */
export function isRecordNotFound(err: unknown): boolean {
  if (!(err instanceof Error) || err.name !== PRISMA_KNOWN_REQUEST_ERROR_NAME) return false;
  return (err as { code?: unknown }).code === PRISMA_RECORD_NOT_FOUND;
}

function targetsColumn(target: unknown, column: string): boolean {
  const wanted = normalize(column);
  if (typeof target === 'string') return normalize(target).includes(wanted);
  if (Array.isArray(target)) return target.some((t) => normalize(String(t)).includes(wanted));
  return true; // sin meta fiable: asumimos el unique esperado (no rompemos la idempotencia)
}

/** dedupKey ≈ dedup_key ≈ panic_events_dedup_key_key: minúsculas y sin guiones bajos. */
function normalize(value: string): string {
  return value.toLowerCase().replaceAll('_', '');
}
