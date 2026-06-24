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
 * RETENCIÓN (seam documentado, política PENDIENTE — decisión de producto): `drainOutbox` marca
 * `publishedAt` pero NADIE borra filas publicadas → la tabla outbox crece sin límite. Cuando se
 * defina la retención, implementala vía `options.retention`: se invoca al final de cada tick
 * exitoso con la cantidad publicada en ese tick (si lanza, cae al mismo manejo de error del tick).
 * Sin hook configurado el comportamiento es EXACTAMENTE el histórico (no-op).
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
} from './outbox-env.js';
import {
  OUTBOX_BATCH_SIZE,
  OUTBOX_CLAIM_STALE_MS,
  OUTBOX_PUBLISH_CONCURRENCY,
  OUTBOX_PUBLISH_TIMEOUT_MS,
} from './outbox-env.js';

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
  /** Seam de retención del outbox (ver doc de la clase). Sin hook = comportamiento histórico. */
  retention?: OutboxRetentionHook;
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
  private timer?: NodeJS.Timeout;
  private running = false;

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
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
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
}
