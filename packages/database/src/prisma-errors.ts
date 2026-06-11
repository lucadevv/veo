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
export function isUniqueViolation(err: unknown, column?: string): err is PrismaUniqueViolationError {
  if (!(err instanceof Error) || err.name !== PRISMA_KNOWN_REQUEST_ERROR_NAME) return false;
  const known = err as Partial<PrismaUniqueViolationError>;
  if (known.code !== PRISMA_UNIQUE_VIOLATION) return false;
  if (column === undefined) return true;
  return targetsColumn(known.meta?.target, column);
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
