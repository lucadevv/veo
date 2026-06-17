/**
 * Lock distribuido best-effort sobre Redis (SET key value EX ttl NX) para jobs periódicos
 * multi-réplica: solo la réplica que adquiere el lock ejecuta el trabajo; el resto SKIPEA
 * (no espera, no reintenta) — la semántica que todos los crons del monorepo ya usaban a mano.
 *
 * Dos modos de liberación, según el tipo de job:
 *  - default (lock-hasta-TTL): el lock NO se libera al terminar; expira solo. Para crons donde
 *    "una corrida por disparo" es la garantía buscada (conciliación diaria, barridos).
 *  - `releaseOnSettle: true`: el lock se libera (DEL) al terminar `fn` (éxito o error). Para
 *    secciones críticas donde otra corrida legítima puede llegar después (poll por tick,
 *    liquidaciones disparables a mano) y un lock residual sería un falso conflicto.
 *
 * NO es un lock de exclusión estricta estilo Redlock (sin token de dueño ni renovación): si `fn`
 * tarda más que el TTL, otra réplica puede entrar. Los jobs que lo usan son idempotentes y el
 * TTL es la cota superior asumida de la corrida — exactamente el contrato de las copias originales.
 */

/**
 * Puerto mínimo del cliente Redis que necesita el lock. Compatible estructuralmente con `ioredis`
 * sin acoplar @veo/utils a esa librería (cada servicio inyecta su cliente compartido).
 */
export interface DistributedLockClient {
  set(
    key: string,
    value: string,
    expiryMode: 'EX',
    ttlSeconds: number,
    condition: 'NX',
  ): Promise<string | null>;
  del(key: string): Promise<number>;
}

/** Valor centinela del lock (las copias originales escribían '1'; no porta información). */
const LOCK_VALUE = '1';
/** Respuesta de Redis cuando SET NX adquiere la clave. */
const LOCK_ACQUIRED_REPLY = 'OK';

export interface WithDistributedLockOptions {
  /**
   * Hook al perder el lock (otra réplica lo tiene). Default: skip totalmente silencioso —
   * la semántica mayoritaria de los crons; los que logueaban el skip pasan su log acá.
   */
  onSkip?: () => void;
  /** true → libera el lock (DEL) cuando `fn` termina (éxito o error). Default: expira por TTL. */
  releaseOnSettle?: boolean;
}

/** Resultado discriminado: si no se adquirió el lock, NO hay resultado (no se ejecutó `fn`). */
export type DistributedLockOutcome<T> = { acquired: false } | { acquired: true; result: T };

/**
 * Ejecuta `fn` solo si adquiere el lock `key` (SET NX EX ttl). Si otra réplica lo tiene,
 * devuelve `{ acquired: false }` sin ejecutar nada (skip). Los errores de `fn` se PROPAGAN
 * (el caller decide cómo loguearlos); los errores del DEL de liberación se tragan: el lock
 * igual expira por TTL y un fallo de limpieza no debe tapar el resultado real de `fn`.
 */
export async function withDistributedLock<T>(
  redis: DistributedLockClient,
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
  options: WithDistributedLockOptions = {},
): Promise<DistributedLockOutcome<T>> {
  const reply = await redis.set(key, LOCK_VALUE, 'EX', ttlSeconds, 'NX');
  if (reply !== LOCK_ACQUIRED_REPLY) {
    options.onSkip?.();
    return { acquired: false };
  }
  try {
    return { acquired: true, result: await fn() };
  } finally {
    if (options.releaseOnSettle) {
      try {
        await redis.del(key);
      } catch {
        // DEL falló (red, cliente fake sin del): el lock expira por TTL; no tapar el resultado de fn.
      }
    }
  }
}
