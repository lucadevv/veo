/**
 * Clasificación de errores de consumidor Kafka: PERMANENTE (poison message) vs TRANSITORIO.
 *
 * CONTEXTO (incidente dev 2026-06): un `trip.completed` con `tripId` NO-UUID envenenó el topic
 * `trip`. zod lo deja pasar (los ids son `z.string()`, no `.uuid()` — y NO los endurecemos porque
 * el blast radius es enorme: todo producer/consumer comparte esos schemas y hoy hay flujos que
 * emiten ids no-UUID, p.ej. tests y reasignaciones). Aguas abajo, Prisma consulta una columna
 * `@db.Uuid` con ese string malformado y tira P2023. Si el handler RELANZA, kafkajs reintenta,
 * el consumidor crashea, reinicia, vuelve al MISMO offset → crash-loop, partición bloqueada.
 *
 * REGLA:
 *  - PERMANENTE  → el payload NUNCA va a procesar (dato malformado para el esquema de la columna).
 *                  El handler debe LOGUEAR (error, con offset/payload) y RETORNAR sin relanzar:
 *                  el offset avanza, la partición sigue. No es un DLQ formal, es "log & skip".
 *  - TRANSITORIO → DB caída, timeout, deadlock, conexión cerrada. El handler debe RELANZAR para
 *                  que kafkajs reintente (el offset NO avanza): el evento es válido, falló el medio.
 *
 * Detección sin acoplar a `@prisma/client` (cada servicio tiene su propio cliente generado): nos
 * basamos en el `code` `Pxxxx` que Prisma expone en el error (`PrismaClientKnownRequestError.code`).
 */

/** Códigos Prisma que indican un PAYLOAD permanentemente inválido (data no procesable). */
const PERMANENT_PRISMA_CODES = new Set<string>([
  'P2023', // Inconsistent column data (típico: UUID malformado en columna @db.Uuid). ← el incidente.
  'P2009', // Failed to validate the query (estructura de datos inválida).
  'P2000', // El valor no entra en la columna (demasiado largo): el dato nunca cabe.
  'P2006', // El valor provisto para el campo no es válido.
]);

function extractPrismaCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'string' && /^P\d{4}$/.test(code)) return code;
  }
  return undefined;
}

/**
 * `true` si el error proviene de un PAYLOAD permanentemente inválido (poison message): reintentar
 * con el MISMO evento dará siempre el mismo error. El handler debe loguear y saltar (no relanzar).
 *
 * `false` para todo lo demás (errores transitorios o desconocidos): se asume transitorio y se
 * RELANZA para que Kafka reintente. "Fail closed hacia el retry": nunca tiramos un evento por un
 * error que quizá sea transitorio; solo saltamos lo que sabemos a ciencia cierta que es veneno.
 */
export function isPermanentDataError(err: unknown): boolean {
  const code = extractPrismaCode(err);
  return code !== undefined && PERMANENT_PRISMA_CODES.has(code);
}

/** RFC 4122 (cualquier versión/variante). Usado para guardar el borde del handler antes de tocar
 *  una columna `@db.Uuid`: un id malformado se descarta SIN llegar a Prisma (evita P2023 de raíz). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `true` si `value` es un UUID con forma canónica. Guardia barata del borde del handler. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
