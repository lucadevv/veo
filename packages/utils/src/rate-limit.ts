/**
 * Rate limiter de VENTANA FIJA atómico sobre Redis, COMPARTIDO por los 3 BFFs (driver/admin/public)
 * para no divergir en N implementaciones del mismo contador (antes cada uno tenía la suya).
 *
 * ATOMICIDAD (la razón de existir): el patrón ingenuo `INCR` + `if (count===1) EXPIRE` son DOS
 * round-trips. Si el proceso/conexión cae entre ambos, la clave queda SIN TTL → contador permanente
 * que bloquea al cliente legítimo PARA SIEMPRE (la ventana nunca expira). Acá `INCR` y el `PEXPIRE`
 * del primer hit van en UN SOLO script Lua (ejecución atómica server-side en Redis): es imposible
 * que una clave recién creada quede sin TTL. El script fija el TTL SOLO en el primer hit, preservando
 * la semántica de ventana FIJA (no se reinicia en cada request, a diferencia de un EXPIRE incondicional).
 */

/**
 * Puerto mínimo del cliente Redis que necesita el limiter: solo `eval` (EVAL de Redis). Compatible
 * estructuralmente con `ioredis` sin acoplar @veo/utils a esa librería (cada BFF inyecta su cliente).
 */
export interface RateLimitRedis {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

/**
 * Script Lua atómico: INCR de la clave y PEXPIRE con la ventana cuando corresponde. Devuelve
 * {count, ttlMs}. Garantía: tras este script una clave existente SIEMPRE tiene TTL > 0. PTTL se
 * consulta dentro del mismo script para que el `Retry-After` que ve el caller sea coherente con el
 * estado atómico.
 *
 * Se fija el PEXPIRE en DOS casos (la unión cubre creación + saneo de legacy):
 *  1. Primer hit (count == 1): el caso normal — la clave nace con TTL.
 *  2. Cualquier hit con PTTL == -1 (clave SIN expiración): saneo de una key LEGACY de un deploy
 *     anterior (o un EXPIRE perdido) que quedó persistente. Sin esto, una key sin TTL con count>max
 *     bloquearía al cliente PARA SIEMPRE (la ventana nunca expira). Mantiene la semántica de ventana
 *     FIJA: una key sana con TTL>0 NO se re-arma en cada request (solo el caso count==1 la fija).
 *     Redis PTTL devuelve -1 si la key existe sin TTL y -2 si no existe (no aplica: el INCR ya la creó).
 *
 * KEYS[1] = clave de la ventana · ARGV[1] = windowMs.
 */
const FIXED_WINDOW_INCR_EXPIRE = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if count == 1 or ttl == -1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = redis.call('PTTL', KEYS[1])
end
return { count, ttl }
` as const;

/** Resultado de consumir un hit de la ventana. */
export interface FixedWindowResult {
  /** ¿Se permite la petición? (count <= max). */
  allowed: boolean;
  /** Hits acumulados en la ventana actual (incluye el actual). */
  count: number;
  /** Límite efectivo aplicado. */
  limit: number;
  /** Restantes en la ventana (nunca negativo). */
  remaining: number;
  /** Milisegundos hasta que la ventana expira (para `Retry-After`). 0 si Redis no devolvió TTL. */
  resetMs: number;
}

/**
 * Registra un hit para `key` en una ventana fija de `windowMs` y decide si se permite según `max`,
 * de forma ATÓMICA (un solo script Lua: INCR + PEXPIRE-en-el-primer-hit + PTTL). La clave creada
 * SIEMPRE queda con TTL — nunca un bucket permanente por una caída entre INCR y EXPIRE.
 */
export async function consumeFixedWindow(
  redis: RateLimitRedis,
  key: string,
  max: number,
  windowMs: number,
): Promise<FixedWindowResult> {
  const raw = (await redis.eval(FIXED_WINDOW_INCR_EXPIRE, 1, key, windowMs)) as [number, number];
  // ioredis devuelve los enteros de Lua como number; defensivo igual (Number) por si llega string.
  const count = Number(raw[0]);
  const ttl = Number(raw[1]);
  const resetMs = ttl > 0 ? ttl : 0;
  return {
    allowed: count <= max,
    count,
    limit: max,
    remaining: Math.max(0, max - count),
    resetMs,
  };
}
