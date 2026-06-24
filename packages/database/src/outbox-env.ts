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

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// RETENCIÓN (FIX: la tabla outbox_events crecía SIN LÍMITE — nadie borraba las filas PUBLICADAS). El relay
// marca `published_at` pero jamás borraba → disco creciente + degradación progresiva de la claim query. La
// retención borra SOLO filas YA ENTREGADAS a Kafka y VIEJAS (publishedAt != NULL AND publishedAt < cutoff).
// NUNCA toca pendientes (publishedAt NULL) ni POISON terminal (failedAt set, publishedAt NULL → excluido por
// el mismo filtro publishedAt != NULL: Ops debe investigarlos, no se pierden en una limpieza automática).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Cuánto se RETIENE una fila ya publicada antes de borrarla (ms). Default 7 DÍAS (604_800_000 ms). El outbox
 * NO es un log permanente — eso es audit-service (inmutable en S3). 7 días cubre de sobra el reproceso/debug
 * (re-publicar manualmente, auditar un envelope) y el at-least-once YA entregó el evento a Kafka hace tiempo:
 * pasada esta ventana la fila es puro lastre. Una fila se borra solo si `published_at < now() - este intervalo`.
 */
export const OUTBOX_RETENTION_MS = 604_800_000; // 7 días
/**
 * Cada cuánto (ms) corre el SWEEP de retención. Default 1 HORA. NO se corre en cada tick del relay (500ms es
 * absurdamente frecuente para un DELETE de mantenimiento): el sweep vive en su PROPIO intervalo, mucho más
 * espaciado. Una fila publicada vive a lo sumo `OUTBOX_RETENTION_MS + OUTBOX_RETENTION_SWEEP_MS` antes de
 * borrarse (el slack del barrido); irrelevante frente a una ventana de 7 días.
 */
export const OUTBOX_RETENTION_SWEEP_MS = 3_600_000; // 1 hora
/**
 * Cuántas filas borra COMO MÁXIMO un solo DELETE del sweep (lote acotado). El sweep hace un loop de DELETEs de
 * este tamaño hasta que un lote vuelve vacío (o se agota el tope de iteraciones por barrido). Acotar el lote
 * evita un lock largo sobre la tabla VIVA (los INSERT de negocio siguen entrando): cada DELETE toca a lo sumo
 * `batch` filas y suelta. 1000 es un punto medio (pocos round-trips, lock corto por lote).
 */
export const OUTBOX_RETENTION_BATCH = 1000;

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
  /** Cuánto retener una fila PUBLICADA antes de borrarla (ms). Default OUTBOX_RETENTION_MS (7 días). */
  OUTBOX_RETENTION_MS: z.coerce.number().int().positive().default(OUTBOX_RETENTION_MS),
  /** Cada cuánto corre el sweep de retención (ms), en su propio intervalo (NO el tick). Default 1h. */
  OUTBOX_RETENTION_SWEEP_MS: z.coerce.number().int().positive().default(OUTBOX_RETENTION_SWEEP_MS),
  /** Filas borradas como MÁXIMO por DELETE del sweep (lote acotado, cero lock largo). Default 1000. */
  OUTBOX_RETENTION_BATCH: z.coerce.number().int().positive().default(OUTBOX_RETENTION_BATCH),
});

/** Forma tipada del entorno del relay (lo que `outboxEnvSchema` produce). */
export type OutboxEnv = z.infer<typeof outboxEnvSchema>;

/** Las opciones del relay que se derivan de env (subconjunto de OutboxRelayOptions). */
export interface OutboxRelayEnvConfig {
  batchSize: number;
  claimStaleMs: number;
  publishConcurrency: number;
  publishTimeoutMs: number;
  retentionMs: number;
  retentionSweepMs: number;
  retentionBatch: number;
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
    retentionMs: config.getOrThrow<number>('OUTBOX_RETENTION_MS'),
    retentionSweepMs: config.getOrThrow<number>('OUTBOX_RETENTION_SWEEP_MS'),
    retentionBatch: config.getOrThrow<number>('OUTBOX_RETENTION_BATCH'),
  };
}
