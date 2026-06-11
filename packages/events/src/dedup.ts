/**
 * Deduplicación de eventos Kafka por `eventId` (utilidad de consumo, junto a poison.ts).
 *
 * Semántica única para los consumers at-least-once de la plataforma:
 *  1. Fast-path: si el `eventId` ya está marcado en Redis, NO se reprocesa (idempotencia barata).
 *  2. Se ejecuta el handler.
 *  3. El dedup se marca DESPUÉS del éxito: si el handler falla, la marca NO se escribe y kafkajs
 *     reintenta el evento sin perder la señal (crítico para `panic.triggered`).
 *
 * CONTRATO (obligatorio para todo caller):
 *  - Los handlers DEBEN ser idempotentes ante reproceso. La ventana GET→SET NO es atómica: dos
 *    entregas concurrentes del mismo `eventId` (o un crash entre el éxito del handler y el SET)
 *    pueden ejecutar el handler más de una vez. El dedup es una optimización barata, no un lock.
 *  - `keyPrefix` aísla el namespace en Redis POR SERVICIO (p.ej. `veo:media:evt:`): dos servicios
 *    que comparten Redis jamás deben compartir prefijo (un eventId procesado por uno NO cuenta
 *    como procesado por el otro).
 */

/** Subconjunto estructural de ioredis que necesita el dedup (no acopla el package a ioredis). */
export interface DedupRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiryMode: 'EX', ttlSeconds: number): Promise<unknown>;
}

/** TTL por defecto de la marca de procesado: 24h (cubre con holgura los reintentos de kafkajs). */
export const DEFAULT_DEDUP_TTL_SECONDS = 86_400;

export interface EventDedupOptions {
  /** Namespace Redis por servicio, p.ej. `veo:media:evt:`. Nunca compartirlo entre servicios. */
  keyPrefix: string;
  /** TTL en segundos de la marca de procesado. Default: {@link DEFAULT_DEDUP_TTL_SECONDS}. */
  ttlSeconds?: number;
}

export type ProcessOutcome<T> =
  | { executed: false } // duplicado: ya procesado con éxito antes
  | { executed: true; result: T };

/** Ejecuta `fn` a lo sumo una vez por `eventId`, marcando el dedup SOLO tras el éxito. */
export async function processEventOnce<T>(
  redis: DedupRedis,
  options: EventDedupOptions,
  eventId: string,
  fn: () => Promise<T>,
): Promise<ProcessOutcome<T>> {
  const dedupKey = `${options.keyPrefix}${eventId}`;
  if ((await redis.get(dedupKey)) !== null) return { executed: false }; // ya procesado

  const result = await fn();
  await redis.set(dedupKey, '1', 'EX', options.ttlSeconds ?? DEFAULT_DEDUP_TTL_SECONDS);
  return { executed: true, result };
}
