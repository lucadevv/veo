/**
 * Outbox pattern (FOUNDATION §6, CLAUDE regla 3).
 * La mutación de dominio y el insert del evento ocurren en la MISMA transacción Postgres.
 * Un relay lee la tabla outbox y publica a Kafka, marcando published_at. Garantiza
 * "exactly-once efectivo": el evento se publica sí o sí si la transacción de negocio commiteó.
 *
 * La tabla vive en el schema de cada servicio (modelo Prisma `OutboxEvent`); aquí va el contrato.
 */
import type { EventEnvelope } from './envelope.js';
import type { KafkaEventProducer } from './kafka.js';
import type { EventPayload, EventType } from './schemas.js';

export interface OutboxRecord {
  id: string;
  aggregateId: string; // key Kafka (id de la entidad raíz)
  envelope: EventEnvelope<unknown>;
  createdAt: Date;
  publishedAt: Date | null;
}

/**
 * Resultado de un tick de drenado. `published` = eventos marcados `published_at` OK. `poisoned` = eventos
 * descartados como PERMANENTES (payload inválido): marcados terminal (`failed_at`), NO se reintentan ni
 * bloquean su grupo. El relay usa `poisoned` para emitir métrica + log (visibilidad de Ops). Se devuelve un
 * objeto (no un number) para SURFACEAR el poison sin tragárselo (at-least-once intacto: published no cambió).
 */
export interface DrainResult {
  /** Eventos publicados OK en este tick (marcados `published_at`). */
  published: number;
  /** Eventos descartados como poison permanente (marcados terminal `failed_at`), con su eventType para la métrica. */
  poisoned: PoisonedEvent[];
}

/** Un evento del outbox descartado como poison permanente (para métrica + log del relay). */
export interface PoisonedEvent {
  id: string;
  eventType: string;
}

/**
 * Puerto que el relay usa para drenar pendientes (lo implementa @veo/database por servicio).
 *
 * `drain` ejecuta CLAIM → PUBLISH → ACK en 3 fases (ver `PrismaOutboxStore`): la publicación a Kafka NO
 * corre dentro de ninguna transacción ni lock de Postgres. La SEGURIDAD multi-réplica ya NO es un advisory
 * lock (que serializaba las réplicas) sino `claimed_at` + `SELECT ... FOR UPDATE SKIP LOCKED`: réplicas
 * concurrentes reclaman lotes DISJUNTOS y drenan en PARALELO sin doble-publish. Un claim sin ack más viejo
 * que `staleMs` se re-toma (recovery de crashes, sin job aparte). El `publish` es el callback a Kafka.
 *
 * El `publish` puede LANZAR. Un error PERMANENTE (payload inválido, `isPermanentPublishError`) → el evento
 * se marca terminal (no reintenta, no bloquea el grupo). Un error TRANSITORIO → reset claim → retry.
 */
export interface OutboxStore {
  drain(
    limit: number,
    staleMs: number,
    concurrency: number,
    publish: (record: OutboxRecord) => Promise<void>,
  ): Promise<DrainResult>;
}

/** Parámetros de drenado del outbox (defaults los fija el relay vía env). */
export interface DrainOutboxOptions {
  /** Máximo de eventos a reclamar por tick (batch size). */
  batchSize: number;
  /** Un claim sin ack más viejo que esto (ms) se re-toma → recovery de crashes. */
  staleMs: number;
  /** Grupos de aggregate publicados en paralelo (orden per-aggregate igual se preserva). */
  concurrency: number;
  /**
   * Timeout (ms) de UN publish individual. DEBE ser < `staleMs` (lo valida el relay). Cierra el double-publish
   * por stale: un publish que excediera `staleMs` dejaría que otra réplica re-tome el claim y re-publique el
   * MISMO id. Con el timeout, el publish o termina o FALLA (transitorio → reset) ANTES de que el claim venza.
   * Un timeout es TRANSITORIO (no poison): el evento es válido, falló el medio (broker lento) → retry. Omitir
   * = sin timeout (comportamiento histórico, para tests que no lo necesitan).
   */
  publishTimeoutMs?: number;
}

/** Error de timeout del publish del outbox. Es TRANSITORIO (no `isPermanentPublishError`) → el relay reintenta. */
export class OutboxPublishTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`outbox: publish excedió el timeout de ${timeoutMs}ms (transitorio: se reintenta)`);
    this.name = 'OutboxPublishTimeoutError';
  }
}

/**
 * Envuelve una promesa de publish con un timeout. Si `timeoutMs` no se pasa, ejecuta tal cual (sin timer).
 * El timer SIEMPRE se limpia (éxito o error) para no filtrar handles ni mantener vivo el event loop.
 */
function withPublishTimeout(publish: Promise<void>, timeoutMs: number | undefined): Promise<void> {
  if (timeoutMs === undefined) return publish;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new OutboxPublishTimeoutError(timeoutMs)), timeoutMs);
    publish.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Relay del outbox: drena pendientes y los publica, SEGURO en multi-réplica (CLAIM con SKIP LOCKED +
 * claimed_at → réplicas drenan lotes disjuntos en paralelo; el publish a Kafka va AFUERA de la tx).
 * Llamar en un intervalo (ej. cada 500ms). Idempotente (republicar es seguro: consumer con dedupKey).
 *
 * Cada `publish` se acota con `options.publishTimeoutMs` (< staleMs): un broker lento NUNCA deja un publish
 * vivo sobre un claim ya vencido (cierra el double-publish por stale de raíz).
 */
export async function drainOutbox(
  store: OutboxStore,
  producer: KafkaEventProducer,
  options: DrainOutboxOptions,
): Promise<DrainResult> {
  return store.drain(options.batchSize, options.staleMs, options.concurrency, (record) =>
    // El envelope se persistió genérico; en publicación T se resuelve por eventType del registro.
    withPublishTimeout(
      producer.publish(
        record.envelope as EventEnvelope<EventPayload<EventType>>,
        record.aggregateId,
      ),
      options.publishTimeoutMs,
    ),
  );
}
