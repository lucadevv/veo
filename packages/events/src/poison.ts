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
    const code = err.code;
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

/**
 * Clasificación de errores de PUBLICACIÓN (lado producer/outbox-relay), hermana de `isPermanentDataError`
 * (lado consumer). Cierra el FIX poison-pill del relay:
 *
 * CAUSA RAÍZ: el relay (PrismaOutboxStore.publishGrouped) capturaba CUALQUIER error del `publish()` y lo
 * trataba como TRANSITORIO (reset claimed_at → retry). Pero `KafkaEventProducer.publish` hace
 * `schema.parse(envelope.payload)` que LANZA un `ZodError` si el payload viola su schema zod — un error
 * PERMANENTE (reintentar da SIEMPRE el mismo error). Resultado previo: ese evento se reintentaba ∞, y como
 * el grupo per-aggregate es SERIAL (orden), un poison en la cabeza BLOQUEABA todos los eventos siguientes de
 * ese aggregate (head-of-line block). Mismo criterio que el poison-safe del consumer base y del
 * `classifyRefundError`: lo PERMANENTE no se reintenta, se marca terminal y se SURFACEA (métrica + log).
 *
 * REGLA:
 *  - PERMANENTE  → el payload NUNCA va a publicar (validación de schema falla SIEMPRE igual). El relay debe
 *                  marcar la fila como TERMINAL-fallida (`failed_at`): NO vuelve a la cola de claim y NO
 *                  bloquea el grupo. El grupo AVANZA al siguiente evento del mismo aggregate.
 *  - TRANSITORIO → broker caído, timeout, red, conexión cerrada. El relay resetea `claimed_at = NULL` → retry.
 *
 * Detección por TIPO, JAMÁS por `err.message`: un `ZodError` (validación de payload) es la señal canónica de
 * payload malformado. Se reconoce de forma estructural (cross-versión de zod, sin acoplar a la clase): un
 * objeto-error con `name === 'ZodError'` y un array `issues`. Esto evita el riesgo de dos copias de zod en el
 * árbol de deps (donde `instanceof ZodError` podría fallar) y replica el criterio "estructural" de
 * `isUniqueViolation`/`isPermanentDataError` (clasificar por shape, no por identidad de clase).
 */
export function isPermanentPublishError(err: unknown): boolean {
  return isZodError(err);
}

/**
 * `true` si `err` es un `ZodError` (reconocido ESTRUCTURALMENTE: `name === 'ZodError'` + `issues: unknown[]`).
 * No usamos `instanceof` para ser robustos a múltiples instancias de zod en el árbol de dependencias.
 */
function isZodError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'name' in err &&
    (err as { name?: unknown }).name === 'ZodError' &&
    'issues' in err &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

/** RFC 4122 (cualquier versión/variante). Usado para guardar el borde del handler antes de tocar
 *  una columna `@db.Uuid`: un id malformado se descarta SIN llegar a Prisma (evita P2023 de raíz). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `true` si `value` es un UUID con forma canónica. Guardia barata del borde del handler. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
