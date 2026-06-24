/**
 * OutboxRelay — drena la tabla outbox del servicio y publica a Kafka (FOUNDATION §6).
 * Bucle cada 500ms. Idempotente (republicar es seguro: dedupKey + clave por entidad).
 *
 * Promovido desde las 12 copias por-servicio (hallazgo POO "patrón en islas"): entre copias
 * lo ÚNICO que variaba era el clientId Kafka y el schema Prisma (advisory lock). El esqueleto
 * (intervalo, batch, publicación vía `drainOutbox`, manejo de error, logs) vive acá, UNA vez.
 *
 * Framework-agnóstico pero NestJS-friendly: expone `onModuleInit`/`onModuleDestroy` duck-typed
 * (Nest invoca los hooks de ciclo de vida en cualquier provider que los tenga, sin decorador).
 * El wiring por servicio es un provider `useFactory` de ~10 líneas con la config que varía.
 *
 * RETENCIÓN (CABLEADA — la tabla ya NO crece sin límite): `drainOutbox` marca `publishedAt` y un SWEEP
 * periódico borra las filas YA PUBLICADAS y VIEJAS (`PrismaOutboxStore.sweepPublished`). El sweep corre en su
 * PROPIO intervalo (`retentionSweepMs`, default 1h) — NO en el tick de 500ms (un DELETE de mantenimiento no va
 * en el hot loop). Borra en LOTES acotados (`retentionBatch`) con SKIP LOCKED → cero lock largo sobre la tabla
 * viva + seguro con N réplicas. NUNCA toca pendientes (publishedAt NULL) ni POISON terminal (publishedAt NULL).
 * Por defecto el sweep está ON con los defaults de env (7 días de retención). Se apaga pasando
 * `retentionMs <= 0` (comportamiento histórico: la tabla no se barre).
 *
 * SEAM LEGADO (`options.retention`): hook opcional que se invoca al final de cada tick exitoso con la cantidad
 * publicada en ese tick. Se mantiene para tests/extensiones; el sweep de retención de filas NO depende de él.
 */
import { createKafka, KafkaEventProducer, drainOutbox } from '@veo/events';
import { outboxPublishPoisonTotal } from '@veo/observability';
import { PrismaOutboxStore, type OutboxPrismaClient } from './outbox.js';
// FUENTE ÚNICA de los 4 defaults del relay: viven en `outbox-env.ts` (sin dependencia de Kafka), que es el
// módulo que los env.schema de los 13 servicios spreadean. Se re-exportan acá para no romper los imports
// históricos `from '@veo/database'` (el barrel re-exporta ambos módulos).
export {
  OUTBOX_BATCH_SIZE,
  OUTBOX_CLAIM_STALE_MS,
  OUTBOX_PUBLISH_CONCURRENCY,
  OUTBOX_PUBLISH_TIMEOUT_MS,
  OUTBOX_RETENTION_MS,
  OUTBOX_RETENTION_SWEEP_MS,
  OUTBOX_RETENTION_BATCH,
} from './outbox-env.js';
import {
  OUTBOX_BATCH_SIZE,
  OUTBOX_CLAIM_STALE_MS,
  OUTBOX_PUBLISH_CONCURRENCY,
  OUTBOX_PUBLISH_TIMEOUT_MS,
  OUTBOX_RETENTION_MS,
  OUTBOX_RETENTION_SWEEP_MS,
  OUTBOX_RETENTION_BATCH,
} from './outbox-env.js';

/**
 * Tope de iteraciones (lotes) por barrido. Cota DURA: aunque haya millones de filas viejas, un solo sweep
 * borra a lo sumo `OUTBOX_RETENTION_BATCH * este tope` filas y termina — el siguiente barrido (al próximo
 * `retentionSweepMs`) sigue desde donde quedó. Evita que un primer barrido sobre un backlog enorme monopolice
 * la conexión indefinidamente. Con batch=1000 → 100k filas por barrido, sobrado para el régimen estacionario.
 */
export const OUTBOX_RETENTION_MAX_BATCHES_PER_SWEEP = 100;

/** Intervalo histórico del bucle del relay (idéntico en las 12 copias originales). */
export const OUTBOX_RELAY_TICK_MS = 500;
/** @deprecated Usar OUTBOX_BATCH_SIZE. Alias del default histórico (mismo valor). */
export const OUTBOX_RELAY_BATCH_SIZE = OUTBOX_BATCH_SIZE;

/** Puerto mínimo de logging (en Nest lo satisface `new Logger(OutboxRelay.name)`). */
export interface OutboxRelayLogger {
  debug(message: string): void;
  error(context: unknown, message?: string): void;
}

/** Hook opcional de retención del outbox (ver doc de la clase). */
export type OutboxRetentionHook = (publishedInTick: number) => Promise<void> | void;

export interface OutboxRelayOptions {
  /** clientId Kafka del servicio (ej. 'trip-service'). */
  clientId: string;
  /** Brokers Kafka (env KAFKA_BROKERS ya spliteado). */
  brokers: string[];
  /** Schema Prisma del servicio (ej. 'trip') → deriva la advisory lock key multi-réplica. */
  schema: string;
  /** Write client Prisma: la escritura de dominio pobló el outbox en la misma transacción. */
  prisma: OutboxPrismaClient;
  /** Logger del servicio. En Nest: `new Logger(OutboxRelay.name)` (contexto idéntico al histórico). */
  logger: OutboxRelayLogger;
  /** Intervalo del bucle. Default: OUTBOX_RELAY_TICK_MS. */
  tickMs?: number;
  /** Batch por tick (limit del CLAIM). Default: OUTBOX_BATCH_SIZE. */
  batchSize?: number;
  /** Un claim sin ack más viejo que esto (ms) se re-toma → recovery de crashes. Default: OUTBOX_CLAIM_STALE_MS. */
  claimStaleMs?: number;
  /** Grupos de aggregate publicados en paralelo. Default: OUTBOX_PUBLISH_CONCURRENCY. */
  publishConcurrency?: number;
  /**
   * Timeout (ms) de UN publish individual. DEBE ser < `claimStaleMs` (invariante anti-double-publish). El
   * ctor lo valida (fail-fast). Default: OUTBOX_PUBLISH_TIMEOUT_MS.
   */
  publishTimeoutMs?: number;
  /**
   * Productor inyectable (tests / productor compartido). Por defecto el relay crea el suyo con
   * clientId+brokers. En AMBOS casos el relay es dueño del ciclo de vida (connect/disconnect).
   */
  producer?: KafkaEventProducer;
  /** Seam LEGADO de retención por-tick (ver doc de la clase). Sin hook = no-op. El sweep de filas NO lo usa. */
  retention?: OutboxRetentionHook;
  /**
   * Cuánto retener una fila PUBLICADA antes de borrarla (ms). Default: OUTBOX_RETENTION_MS (7 días). `<= 0`
   * APAGA el sweep (la tabla no se barre — comportamiento histórico).
   */
  retentionMs?: number;
  /** Cada cuánto corre el sweep de retención (ms), en su PROPIO intervalo (NO el tick). Default: OUTBOX_RETENTION_SWEEP_MS. */
  retentionSweepMs?: number;
  /** Filas borradas como MÁXIMO por DELETE del sweep (lote acotado). Default: OUTBOX_RETENTION_BATCH. */
  retentionBatch?: number;
}

export class OutboxRelay {
  private readonly logger: OutboxRelayLogger;
  private readonly producer: KafkaEventProducer;
  private readonly store: PrismaOutboxStore;
  private readonly tickMs: number;
  private readonly batchSize: number;
  private readonly claimStaleMs: number;
  private readonly publishConcurrency: number;
  private readonly publishTimeoutMs: number;
  private readonly retention?: OutboxRetentionHook;
  private readonly retentionMs: number;
  private readonly retentionSweepMs: number;
  private readonly retentionBatch: number;
  private timer?: NodeJS.Timeout;
  private sweepTimer?: NodeJS.Timeout;
  private running = false;
  private sweeping = false;

  constructor(options: OutboxRelayOptions) {
    this.logger = options.logger;
    this.producer =
      options.producer ??
      new KafkaEventProducer(createKafka({ clientId: options.clientId, brokers: options.brokers }));
    // OutboxStore sobre el write client (la escritura de dominio pobló el outbox en la misma tx).
    this.store = new PrismaOutboxStore(options.prisma, options.schema);
    this.tickMs = options.tickMs ?? OUTBOX_RELAY_TICK_MS;
    this.batchSize = options.batchSize ?? OUTBOX_BATCH_SIZE;
    this.claimStaleMs = options.claimStaleMs ?? OUTBOX_CLAIM_STALE_MS;
    this.publishConcurrency = options.publishConcurrency ?? OUTBOX_PUBLISH_CONCURRENCY;
    this.publishTimeoutMs = options.publishTimeoutMs ?? OUTBOX_PUBLISH_TIMEOUT_MS;
    this.retention = options.retention;
    this.retentionMs = options.retentionMs ?? OUTBOX_RETENTION_MS;
    this.retentionSweepMs = options.retentionSweepMs ?? OUTBOX_RETENTION_SWEEP_MS;
    this.retentionBatch = options.retentionBatch ?? OUTBOX_RETENTION_BATCH;

    // INVARIANTE ESTRUCTURAL (fail-fast): el timeout de un publish DEBE ser < el stale-window del claim. Si
    // no, un publish lento podría seguir vivo cuando su claim ya venció → otra réplica lo re-toma → DOBLE
    // PUBLISH del mismo id. Lo validamos en el boot: una mala config no arranca (no se descubre en prod).
    if (this.publishTimeoutMs >= this.claimStaleMs) {
      throw new Error(
        `outbox: publishTimeoutMs (${this.publishTimeoutMs}ms) debe ser < claimStaleMs (${this.claimStaleMs}ms) ` +
          `para cerrar el double-publish por stale: un publish nunca debe seguir vivo tras vencer su claim.`,
      );
    }
  }

  async onModuleInit(): Promise<void> {
    await this.producer.connect();
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    // SWEEP de retención en su PROPIO intervalo (no el tick de 500ms). Apagado si retentionMs <= 0.
    if (this.retentionMs > 0) {
      this.sweepTimer = setInterval(() => void this.sweep(), this.retentionSweepMs);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.producer.disconnect();
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await drainOutbox(this.store, this.producer, {
        batchSize: this.batchSize,
        staleMs: this.claimStaleMs,
        concurrency: this.publishConcurrency,
        publishTimeoutMs: this.publishTimeoutMs,
      });
      if (result.published > 0) this.logger.debug(`outbox: publicados ${result.published} eventos`);
      // POISON terminal: un payload inválido se descartó (marcado failed_at) para NO bloquear el grupo ni
      // reintentarse ∞. Lo SURFACEAMOS por métrica + log ERROR: el dato se perdió a propósito, Ops debe ver
      // el producer que emitió el payload malformado. No tira el tick (los eventos sanos siguieron publicando).
      for (const p of result.poisoned) {
        outboxPublishPoisonTotal.inc({ event: p.eventType });
        this.logger.error(
          { outboxId: p.id, eventType: p.eventType },
          'outbox: evento POISON descartado (payload inválido, marcado terminal failed_at) — revisar el producer',
        );
      }
      if (this.retention) await this.retention(result.published);
    } catch (err) {
      this.logger.error({ err }, 'outbox relay falló');
    } finally {
      this.running = false;
    }
  }

  /**
   * SWEEP de retención (su propio intervalo, NO el tick). Borra filas YA PUBLICADAS y más viejas que
   * `retentionMs`, en LOTES acotados de `retentionBatch` (cero lock largo) hasta que un lote vuelve
   * `< retentionBatch` (no quedan más viejas) o se alcanza el tope de iteraciones por barrido. Seguro
   * multi-réplica: el DELETE usa SKIP LOCKED (lotes disjuntos, sin deadlock). Un guard `sweeping` evita
   * solapar dos barridos si uno se pasa de largo. Un fallo se loguea pero NO tira el relay (el tick sigue).
   */
  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      let deletedTotal = 0;
      for (let i = 0; i < OUTBOX_RETENTION_MAX_BATCHES_PER_SWEEP; i++) {
        const deleted = await this.store.sweepPublished(this.retentionMs, this.retentionBatch);
        deletedTotal += deleted;
        // Lote no lleno ⇒ ya no quedan filas publicadas viejas → terminamos este barrido.
        if (deleted < this.retentionBatch) break;
      }
      if (deletedTotal > 0) {
        this.logger.debug(`outbox: retención borró ${deletedTotal} filas publicadas viejas`);
      }
    } catch (err) {
      this.logger.error({ err }, 'outbox sweep de retención falló');
    } finally {
      this.sweeping = false;
    }
  }
}
