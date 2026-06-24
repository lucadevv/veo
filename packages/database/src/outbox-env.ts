/**
 * Configuración del OutboxRelay vía ENTORNO (FIX: cablear las perillas del relay a env).
 *
 * CAUSA RAÍZ del hueco: `OUTBOX_BATCH_SIZE / CLAIM_STALE_MS / PUBLISH_CONCURRENCY / PUBLISH_TIMEOUT_MS` eran
 * constantes de módulo. `OutboxRelayOptions` las exponía, pero NINGÚN wiring de servicio las pasaba desde env →
 * el stale-window (la perilla del double-publish) no era tuneable sin redeploy del binario.
 *
 * Esta es la fuente ÚNICA y tipada de esas vars: las 4 CONSTANTES de default viven acá (abajo) y cada servicio que
 * corre el relay SPREADEA `outboxEnvSchema.shape` en su `env.schema.ts` (fail-fast en el boot, defaults = estas
 * constantes, cero números mágicos sueltos) y su wiring llama `outboxRelayConfigFromEnv(config)` para leerlas del
 * ConfigService VALIDADO y pasárselas al `OutboxRelay`. Un solo lugar define nombre, tipo, default e invariante.
 */
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// FUENTE ÚNICA de los 4 defaults del relay (cero números mágicos duplicados). Viven ACÁ (no en outbox-relay.ts)
// a propósito: este módulo NO depende de Kafka, así que los 13 `env.schema.ts` lo importan barato para spreadear
// `outboxEnvSchema.shape` sin arrastrar @veo/events al boot de su config. `outbox-relay.ts` las re-exporta para
// no romper los imports históricos `from '@veo/database'`.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Tamaño del batch por tick (cuántos eventos reclama el CLAIM). Históricamente 100. Es el `limit` de la claim query. */
export const OUTBOX_BATCH_SIZE = 100;
/**
 * Tras este tiempo (ms) un evento reclamado pero sin ack (proceso muerto entre claim y ack) se considera STALE y
 * otra réplica lo re-toma. Cota inferior > el peor tick razonable; cota superior = latencia máxima tolerable de
 * re-publicación tras un crash. 60s es un punto medio seguro.
 */
export const OUTBOX_CLAIM_STALE_MS = 60_000;
/**
 * Cuántos grupos de aggregate se publican a Kafka EN PARALELO por tick. Dentro de cada grupo el publish es serial
 * (orden per-aggregate). Más concurrencia = más throughput entre aggregates distintos, a costa de más sockets Kafka
 * simultáneos. 8 es conservador para el productor compartido del relay.
 */
export const OUTBOX_PUBLISH_CONCURRENCY = 8;
/**
 * TIMEOUT (ms) de UN publish individual a Kafka. INVARIANTE ESTRUCTURAL (cierra el double-publish por stale): debe
 * ser ESTRICTAMENTE < `OUTBOX_CLAIM_STALE_MS`. El race que cierra: un publish que se cuelga MÁS de CLAIM_STALE_MS
 * dejaría que otra réplica re-tome el claim stale y RE-PUBLIQUE el MISMO id (doble-publish). Con el timeout, un
 * publish o termina o falla (→ transitorio, reset) ANTES de que su claim venza. 30s < 60s da margen. Validado en
 * el ctor del OutboxRelay.
 */
export const OUTBOX_PUBLISH_TIMEOUT_MS = 30_000;

/**
 * Fragmento de schema zod con las 4 perillas del relay. Cada servicio lo spreadea en su env.schema:
 *   z.object({ ...otrasVars, ...outboxEnvSchema.shape })
 * `z.coerce.number()` parsea el string del entorno; `.int().positive()` valida; el default = la constante.
 */
export const outboxEnvSchema = z.object({
  /** Eventos reclamados por tick (limit del CLAIM). Default: OUTBOX_BATCH_SIZE. */
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(OUTBOX_BATCH_SIZE),
  /** Un claim sin ack más viejo que esto (ms) se re-toma → recovery de crashes. Default: OUTBOX_CLAIM_STALE_MS. */
  OUTBOX_CLAIM_STALE_MS: z.coerce.number().int().positive().default(OUTBOX_CLAIM_STALE_MS),
  /** Grupos de aggregate publicados en paralelo. Default: OUTBOX_PUBLISH_CONCURRENCY. */
  OUTBOX_PUBLISH_CONCURRENCY: z.coerce.number().int().positive().default(OUTBOX_PUBLISH_CONCURRENCY),
  /**
   * Timeout (ms) de UN publish. INVARIANTE: debe ser < OUTBOX_CLAIM_STALE_MS (cierra el double-publish por
   * stale). El `OutboxRelay` lo valida en el ctor (fail-fast). Default: OUTBOX_PUBLISH_TIMEOUT_MS.
   */
  OUTBOX_PUBLISH_TIMEOUT_MS: z.coerce.number().int().positive().default(OUTBOX_PUBLISH_TIMEOUT_MS),
});

/** Forma tipada del entorno del relay (lo que `outboxEnvSchema` produce). */
export type OutboxEnv = z.infer<typeof outboxEnvSchema>;

/** Las opciones del relay que se derivan de env (subconjunto de OutboxRelayOptions). */
export interface OutboxRelayEnvConfig {
  batchSize: number;
  claimStaleMs: number;
  publishConcurrency: number;
  publishTimeoutMs: number;
}

/** Lo mínimo del ConfigService de Nest que necesitamos (estructural: no acopla a @nestjs/config). */
export interface OutboxEnvReader {
  getOrThrow<T = string>(key: string): T;
}

/**
 * Lee las 4 perillas del relay desde un ConfigService VALIDADO (el env ya pasó por `outboxEnvSchema`) y las
 * mapea a las opciones del `OutboxRelay`. El wiring de cada servicio hace:
 *   new OutboxRelay({ clientId, schema, brokers, prisma, logger, ...outboxRelayConfigFromEnv(config) })
 */
export function outboxRelayConfigFromEnv(config: OutboxEnvReader): OutboxRelayEnvConfig {
  return {
    batchSize: config.getOrThrow<number>('OUTBOX_BATCH_SIZE'),
    claimStaleMs: config.getOrThrow<number>('OUTBOX_CLAIM_STALE_MS'),
    publishConcurrency: config.getOrThrow<number>('OUTBOX_PUBLISH_CONCURRENCY'),
    publishTimeoutMs: config.getOrThrow<number>('OUTBOX_PUBLISH_TIMEOUT_MS'),
  };
}
