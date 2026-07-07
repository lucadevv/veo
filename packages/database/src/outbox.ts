/**
 * Outbox pattern lado Prisma (FOUNDATION §6, CLAUDE regla 3).
 * `enqueueOutbox` se llama DENTRO de la misma transacción que la mutación de dominio.
 * `PrismaOutboxStore` implementa el OutboxStore que el relay de @veo/events drena a Kafka.
 *
 * DESACOPLE I/O ↔ TX (causa raíz del thrashing previo): el diseño es CLAIM → PUBLISH → ACK en 3 fases.
 * La publicación a Kafka (N sends de red, lentos) NO ocurre dentro de ninguna transacción ni lock de
 * Postgres. Antes, `drainLocked` sostenía un `pg_try_advisory_xact_lock` + la tx (timeout 15s) durante
 * todos los sends serie: un broker lento agotaba la tx → rollback → re-publicaba el batch (thrashing) +
 * retenía conexión del pool + lock. Ahora:
 *
 *   FASE 1 — CLAIM (tx corta, atómica): un UPDATE ... FOR UPDATE SKIP LOCKED marca `claimed_at = now()`
 *   sobre el lote y lo devuelve. SKIP LOCKED + `claimed_at` reemplazan el advisory lock: réplicas
 *   concurrentes toman lotes DISJUNTOS (drenado paralelo, cero doble-publish) sin serializarse. Los
 *   claims viejos (`claimed_at < now - stale`) se re-toman → recovery automático de crashes, sin job aparte.
 *
 *   FASE 2 — PUBLISH (AFUERA de toda tx): se publica a Kafka sin tx/lock abierto. Se agrupa por
 *   `aggregateId` y se publican los GRUPOS en paralelo (límite de concurrencia), SERIAL dentro de cada
 *   grupo en orden `createdAt` → orden per-aggregate preservado + paralelismo entre aggregates distintos.
 *
 *   FASE 3 — ACK (tx corta): `published_at = now()` para los éxitos; `claimed_at = NULL` para los fallos
 *   transitorios (retry inmediato el próximo tick); `failed_at = now()` para los POISON permanentes (payload
 *   inválido: reintentar da SIEMPRE el mismo error → TERMINAL, no vuelve a la cola de claim ni bloquea el
 *   grupo). Un CRASH entre claim y ack deja `claimed_at` set → el stale-reclaim lo recupera. AT-LEAST-ONCE:
 *   si el ack falla DESPUÉS de publicar OK, la fila queda claimed (no published) → stale-reclaim → re-publica
 *   → el consumer idempotente (dedupKey) descarta el duplicado.
 *
 * POISON-PILL (FIX): un payload que viola su schema zod hace que `KafkaEventProducer.publish` lance un
 * `ZodError` ANTES del send — error PERMANENTE. Antes se trataba como transitorio (reset claimed_at → retry
 * ∞) y, como el grupo per-aggregate es SERIAL, un poison en la cabeza BLOQUEABA todos los siguientes de ese
 * aggregate. Ahora `publishGrouped` clasifica con `isPermanentPublishError`: PERMANENTE → terminal (`failed_at`)
 * y el grupo AVANZA al siguiente; TRANSITORIO → fallo (reset) y el grupo se DETIENE (preservar orden).
 *
 * ORDEN INTRA-TX DETERMINISTA (FIX seq): dos eventos del MISMO aggregate emitidos en la MISMA tx comparten
 * `created_at` (= transaction_timestamp() del default `now()`) AL µs. El desempate viejo por `eventId` (uuidv7)
 * NO servía: la cola de un v7 es RANDOM dentro del mismo ms (RFC 9562 §5.7, ver @veo/utils) → dos eventos del
 * mismo aggregate/misma tx se ordenaban AL AZAR → el consumer (Kafka ordena por key=aggregateId según orden de
 * PRODUCE) los veía fuera de orden. El fix de RAÍZ es una SECUENCIA MONOTÓNICA `seq` (orden de INSERCIÓN
 * estricto, inmune al clock y al uuid): el tiebreak pasa a `(created_at, seq)` en AMBOS lados — el CLAIM
 * (ORDER BY created_at, seq → límite del batch determinista) y el re-sort de `publishGrouped`.
 *
 * Cada servicio que publica eventos debe incluir este modelo en su schema.prisma (ver OUTBOX_PRISMA_MODEL):
 *   model OutboxEvent {
 *     id          String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
 *     seq          BigInt   @default(autoincrement())
 *     aggregateId String   @map("aggregate_id")
 *     eventType   String   @map("event_type")
 *     envelope    Json
 *     createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz
 *     publishedAt DateTime? @map("published_at") @db.Timestamptz
 *     claimedAt   DateTime? @map("claimed_at") @db.Timestamptz
 *     failedAt    DateTime? @map("failed_at") @db.Timestamptz
 *     @@index([publishedAt, failedAt, claimedAt, createdAt, seq])
 *     @@map("outbox_events")
 *     @@schema("<servicio>")
 *   }
 */
import {
  isPermanentPublishError,
  type DrainResult,
  type EventEnvelope,
  type OutboxRecord,
  type OutboxStore,
  type PoisonedEvent,
} from '@veo/events';

/**
 * Template del modelo OutboxEvent que cada servicio copia a su schema.prisma. El índice
 * `[publishedAt, failedAt, claimedAt, createdAt, seq]` sirve la claim query (filtra pendientes = publishedAt IS
 * NULL + failedAt IS NULL, descarta claim vigente, ordena por `(createdAt, seq)`). `claimedAt` y `failedAt` son
 * aditivos y nullable. `failedAt` marca un evento POISON terminal (payload inválido): el claim lo EXCLUYE para
 * que no se reintente ni bloquee su grupo per-aggregate. `seq` es la secuencia monotónica de INSERCIÓN: el
 * tiebreak determinista del orden intra-tx (created_at idéntico) — la columna del ORDER BY que hace el batch del
 * claim y el orden de publicación REPRODUCIBLES.
 */
export const OUTBOX_PRISMA_MODEL = `model OutboxEvent {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  seq         BigInt    @default(autoincrement())
  aggregateId String    @map("aggregate_id")
  eventType   String    @map("event_type")
  envelope    Json
  createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz
  publishedAt DateTime? @map("published_at") @db.Timestamptz
  claimedAt   DateTime? @map("claimed_at") @db.Timestamptz
  failedAt    DateTime? @map("failed_at") @db.Timestamptz

  @@index([publishedAt, failedAt, claimedAt, createdAt, seq])
  @@map("outbox_events")
}`;

/**
 * Identificador Postgres válido (lo que puede ir como nombre de schema SIN comillas dobles ni inyección):
 * empieza con letra/underscore, sigue con letras/dígitos/underscore. El schema viene del constructor (no del
 * usuario), pero se valida igual: defensa en profundidad antes de interpolarlo en el SQL del claim/ack.
 */
const POSTGRES_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Delegate estructural de Prisma para el modelo OutboxEvent (write client o tx client). */
export interface OutboxDelegate {
  create(args: { data: OutboxCreateData }): Promise<unknown>;
}

interface OutboxCreateData {
  aggregateId: string;
  eventType: string;
  envelope: unknown;
}

/**
 * Fila tal como la devuelve el CLAIM (snake_case del raw SQL). `seq` es la secuencia monotónica de inserción
 * (BIGINT). Postgres la devuelve como `bigint` → `node-postgres`/Prisma raw la mapean a `string` (un bigint no
 * entra en un `number` JS sin perder precisión). Se compara como BigInt para el desempate, NUNCA como number.
 */
interface ClaimedRow {
  id: string;
  seq: string;
  aggregate_id: string;
  event_type: string;
  envelope: unknown;
  created_at: Date;
}

/**
 * Encola un evento en el outbox dentro de una transacción.
 * `tx` es el cliente de transacción (o el write client) que tenga `.outboxEvent`.
 */
export async function enqueueOutbox(
  tx: { outboxEvent: OutboxDelegate },
  envelope: EventEnvelope<unknown>,
  aggregateId: string,
): Promise<void> {
  await tx.outboxEvent.create({
    data: { aggregateId, eventType: envelope.eventType, envelope: envelope },
  });
}

/**
 * Cliente Prisma (write client) con lo que el store necesita. Estructural: NO acopla a @prisma/client.
 * Las fases CLAIM y ACK usan `$queryRawUnsafe`/`$executeRawUnsafe` con parámetros posicionales (`$1`, `$2`):
 * el schema (identificador validado) se interpola, los valores (limit, staleMs, ids) van PARAMETRIZADOS.
 */
export interface OutboxPrismaClient {
  outboxEvent: OutboxDelegate;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/**
 * Resultado de la fase PUBLISH:
 *  - `succeeded`: ids publicados OK (→ `published_at`).
 *  - `failed`:    ids cuyo publish lanzó un error TRANSITORIO (→ reset `claimed_at` = NULL, retry).
 *  - `poisoned`:  eventos cuyo publish lanzó un error PERMANENTE (payload inválido) → terminal (`failed_at`).
 *                 Llevan el eventType para la métrica/log del relay (visibilidad de Ops).
 */
interface PublishOutcome {
  succeeded: string[];
  failed: string[];
  poisoned: PoisonedEvent[];
}

/**
 * Implementación de OutboxStore (de @veo/events) sobre Prisma, en 3 fases (claim → publish → ack).
 * Desacopla la publicación a Kafka de la transacción/lock de Postgres (ver doc del módulo).
 */
export class PrismaOutboxStore implements OutboxStore {
  /** Schema VALIDADO (identificador Postgres) — seguro para interpolar en el SQL del claim/ack. */
  private readonly schema: string;

  constructor(
    private readonly prisma: OutboxPrismaClient,
    schema: string,
  ) {
    if (!POSTGRES_IDENTIFIER.test(schema)) {
      throw new Error(`outbox: schema inválido (no es un identificador Postgres): ${schema}`);
    }
    this.schema = schema;
  }

  /**
   * Drena el outbox en 3 fases SIN sostener tx/lock durante la I/O a Kafka.
   *
   * @param limit       máximo de eventos a reclamar por tick (batch size).
   * @param staleMs     un claim sin ack más viejo que esto se re-toma (recovery de crashes).
   * @param concurrency grupos de aggregate publicados en paralelo (orden per-aggregate igual se preserva).
   * @param publish     publica un OutboxRecord a Kafka. Lanza si falla. Un error PERMANENTE
   *                    (`isPermanentPublishError`, p.ej. ZodError de payload) → terminal (no reintenta, no
   *                    bloquea el grupo); cualquier otro error → transitorio (reset claim → retry).
   * @returns           DrainResult: cuántos se publicaron OK + qué eventos se marcaron poison terminal.
   */
  async drain(
    limit: number,
    staleMs: number,
    concurrency: number,
    publish: (record: OutboxRecord) => Promise<void>,
  ): Promise<DrainResult> {
    const claimed = await this.claim(limit, staleMs);
    if (claimed.length === 0) return { published: 0, poisoned: [] };

    const outcome = await this.publishGrouped(claimed, concurrency, publish);
    await this.ack(outcome);
    return { published: outcome.succeeded.length, poisoned: outcome.poisoned };
  }

  /**
   * FASE 1 — CLAIM (tx corta atómica): marca `claimed_at = now()` sobre hasta `limit` filas pendientes
   * (publishedAt IS NULL, failedAt IS NULL = NO poison terminal, y sin claim vigente) y las devuelve. El
   * filtro `failed_at IS NULL` excluye los POISON terminales (no se reintentan). `FOR UPDATE SKIP LOCKED` deja que réplicas
   * concurrentes tomen lotes DISJUNTOS sin bloquearse (drenado paralelo). El UPDATE es atómico: las filas
   * quedan "claimed" antes de soltar la conexión, así que ninguna otra réplica las vuelve a tomar hasta el
   * ack o hasta que el claim quede stale.
   *
   * ORDEN DETERMINISTA DEL BATCH: el inner SELECT ordena por `(created_at ASC, seq ASC)`. `created_at` solo NO
   * basta — eventos de la misma tx comparten timestamp y el corte del `LIMIT` quedaría no-determinista (qué N
   * filas entran al batch cambiaría entre ticks). `seq` (secuencia de inserción, monotónica) lo hace REPRODUCIBLE.
   *
   * SEGURIDAD SQL: el `schema` está validado como identificador Postgres en el ctor → seguro de interpolar.
   * `staleMs` y `limit` van como parámetros posicionales ($1, $2), JAMÁS interpolados como string. El
   * intervalo stale se construye en SQL desde el parámetro: `now() - ($1::double precision * interval '1 ms')`.
   */
  private async claim(limit: number, staleMs: number): Promise<ClaimedRow[]> {
    const sql = `
      UPDATE "${this.schema}"."outbox_events"
      SET claimed_at = now()
      WHERE id IN (
        SELECT id FROM "${this.schema}"."outbox_events"
        WHERE published_at IS NULL
          AND failed_at IS NULL
          AND (claimed_at IS NULL OR claimed_at < now() - ($1::double precision * interval '1 millisecond'))
        ORDER BY created_at ASC, seq ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, seq, aggregate_id, event_type, envelope, created_at`;
    return this.prisma.$queryRawUnsafe<ClaimedRow[]>(sql, staleMs, limit);
  }

  /**
   * FASE 2 — PUBLISH (AFUERA de toda tx): agrupa por `aggregateId` y publica los grupos con un worker-pool
   * acotado a `concurrency`. DENTRO de cada grupo es SERIAL en orden `createdAt` (las filas ya vienen
   * ordenadas del claim) → orden per-aggregate preservado.
   *
   * POISON vs TRANSITORIO (FIX poison-pill): si el publish del evento k LANZA, se clasifica el error:
   *  - PERMANENTE (`isPermanentPublishError`, p.ej. ZodError de payload inválido): el evento k es VENENO.
   *    Reintentarlo da SIEMPRE el mismo error → se marca TERMINAL (`failed_at`) y el grupo NO se detiene:
   *    AVANZA al evento k+1 del mismo aggregate. Así un poison en la CABEZA no congela el aggregate para
   *    siempre (head-of-line desbloqueado). El orden per-aggregate de los eventos SANOS se preserva: el
   *    poison se SALTA (se descartó permanentemente, no es un evento que vaya a publicarse nunca).
   *  - TRANSITORIO (broker caído, timeout): este id y TODOS los > k del MISMO grupo NO se publican
   *    (preservar orden per-aggregate) y van a `failed` (reset claim → retry el próximo tick).
   */
  private async publishGrouped(
    rows: ClaimedRow[],
    concurrency: number,
    publish: (record: OutboxRecord) => Promise<void>,
  ): Promise<PublishOutcome> {
    // El `ORDER BY created_at, seq` del CLAIM elige QUÉ filas se reclaman, pero el orden del RETURNING de un
    // UPDATE NO está garantizado en Postgres (suele ser orden físico). Re-ordenamos en código por
    // (createdAt ASC, seq ASC) ANTES de agrupar → orden per-aggregate DETERMINISTA. DESEMPATE por `seq` (la
    // secuencia monotónica de INSERCIÓN) y NO por `eventId` (uuidv7, cuya cola es RANDOM dentro del mismo ms):
    // dos eventos del MISMO aggregate emitidos en la MISMA tx comparten created_at AL µs → solo `seq` los
    // ordena por orden de creación REAL, inmune al clock y al uuid random. `seq` llega como string (bigint de
    // Postgres) → se compara como BigInt, jamás como number (preserva precisión más allá de 2^53).
    const ordered = [...rows].sort((x, y) => {
      const d = x.created_at.getTime() - y.created_at.getTime();
      if (d !== 0) return d;
      const sx = BigInt(x.seq);
      const sy = BigInt(y.seq);
      return sx < sy ? -1 : sx > sy ? 1 : 0;
    });

    // Agrupa preservando el orden de llegada (createdAt ASC, seq ASC) dentro de cada aggregate.
    const groups = new Map<string, ClaimedRow[]>();
    for (const r of ordered) {
      const g = groups.get(r.aggregate_id);
      if (g) g.push(r);
      else groups.set(r.aggregate_id, [r]);
    }

    const succeeded: string[] = [];
    const failed: string[] = [];
    const poisoned: PoisonedEvent[] = [];
    // Cola FIFO: los grupos se despachan en el orden en que aparecieron (Map preserva inserción =
    // createdAt ASC del claim). Un puntero `next` evita el O(n) de Array.shift por grupo. FIFO (no LIFO)
    // mantiene el orden GLOBAL de creación entre aggregates distintos, no solo el per-aggregate.
    const queue = [...groups.values()];
    let next = 0;
    const takeGroup = (): ClaimedRow[] | undefined =>
      next < queue.length ? queue[next++] : undefined;

    const publishGroup = async (group: ClaimedRow[]): Promise<void> => {
      for (const [i, r] of group.entries()) {
        try {
          await publish({
            id: r.id,
            aggregateId: r.aggregate_id,
            envelope: r.envelope as EventEnvelope<unknown>,
            createdAt: r.created_at,
            publishedAt: null,
          });
          succeeded.push(r.id);
        } catch (err) {
          if (isPermanentPublishError(err)) {
            // POISON permanente: marcalo terminal y SEGUÍ con el siguiente del grupo (NO bloquear el aggregate).
            poisoned.push({ id: r.id, eventType: r.event_type });
            continue;
          }
          // Fallo transitorio: este id y TODOS los > i del MISMO grupo NO se publican (orden per-aggregate).
          for (const rest of group.slice(i)) failed.push(rest.id);
          return;
        }
      }
    };

    // Worker-pool tipado: `concurrency` workers consumen la cola de grupos hasta agotarla.
    const workerCount = Math.max(1, Math.min(concurrency, queue.length));
    const worker = async (): Promise<void> => {
      for (let group = takeGroup(); group !== undefined; group = takeGroup()) {
        await publishGroup(group);
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return { succeeded, failed, poisoned };
  }

  /**
   * FASE 3 — ACK (tx corta): marca `published_at = now()` los éxitos, resetea `claimed_at = NULL` los fallos
   * transitorios (→ retry inmediato el próximo tick) y marca `failed_at = now()` los POISON permanentes (→
   * TERMINAL: el claim los excluye, no se reintentan ni bloquean su grupo). Cada UPDATE es atómico y acotado
   * por id, sin sostener nada durante I/O. Las tres sentencias son independientes (conjuntos de ids disjuntos).
   *
   * AT-LEAST-ONCE: si este ack lanza DESPUÉS de que el publish salió OK, las filas quedan claimed (no
   * published) → el stale-reclaim las re-toma → se re-publican → el consumer idempotente (dedupKey) las
   * descarta. Correcto: nunca se pierde un evento publicado. (Un poison NO es "evento publicado": su
   * payload nunca llegó a Kafka, se descarta a propósito y se SURFACEA por métrica/log.)
   */
  private async ack(outcome: PublishOutcome): Promise<void> {
    if (outcome.succeeded.length > 0) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE "${this.schema}"."outbox_events" SET published_at = now() WHERE id = ANY($1::uuid[])`,
        outcome.succeeded,
      );
    }
    if (outcome.failed.length > 0) {
      await this.prisma.$executeRawUnsafe(
        `UPDATE "${this.schema}"."outbox_events" SET claimed_at = NULL WHERE id = ANY($1::uuid[])`,
        outcome.failed,
      );
    }
    if (outcome.poisoned.length > 0) {
      // TERMINAL: failed_at marca el poison y limpia claimed_at (libera el marcador). El claim filtra por
      // failed_at IS NULL → este evento NUNCA se re-reclama (no retry ∞, no head-of-line block).
      await this.prisma.$executeRawUnsafe(
        `UPDATE "${this.schema}"."outbox_events" SET failed_at = now(), claimed_at = NULL WHERE id = ANY($1::uuid[])`,
        outcome.poisoned.map((p) => p.id),
      );
    }
  }

  /**
   * RETENCIÓN — borra filas YA PUBLICADAS y VIEJAS (FIX: la tabla crecía sin límite; nadie borraba lo publicado).
   *
   * QUÉ BORRA (y qué NO):
   *  - SÍ: `published_at IS NOT NULL AND published_at < now() - retención`. La fila ya se entregó a Kafka hace
   *    más que la ventana de retención → es puro lastre (el at-least-once ya cumplió; el reproceso/debug ya pasó).
   *  - NO pendientes: `published_at IS NULL` queda FUERA (aún no entregadas — pendientes o claimed en vuelo).
   *  - NO poison terminal: un POISON tiene `failed_at` set pero `published_at NULL` (su payload nunca llegó a
   *    Kafka) → el MISMO filtro `published_at IS NOT NULL` lo EXCLUYE. Ops debe investigar los poison; la
   *    limpieza automática JAMÁS los toca.
   *
   * SIN LOCK LARGO (lote acotado): un solo DELETE toca a lo sumo `batch` filas vía un subselect `LIMIT batch`;
   * el loop externo (en el relay) repite hasta que un sweep vuelve `< batch` (no quedan más viejas). Nunca se
   * bloquea la tabla VIVA entera: los INSERT de negocio siguen entrando entre lotes.
   *
   * MULTI-RÉPLICA SEGURO (SKIP LOCKED, sin deadlock): el subselect usa `FOR UPDATE SKIP LOCKED` (igual que el
   * CLAIM). Con N réplicas barriendo a la vez, cada una toma un lote DISJUNTO de filas (las que otra ya bloqueó
   * se saltan) → no se pelean por las mismas filas, no se bloquean entre sí, no hay deadlock. El orden estable
   * `ORDER BY published_at ASC, seq ASC` hace el lote determinista (las más viejas primero).
   *
   * SEGURIDAD SQL: `schema` validado como identificador Postgres en el ctor → seguro de interpolar. La ventana
   * de retención va PARAMETRIZADA ($1) y el límite del lote también ($2): jamás interpolados como string.
   *
   * @param retentionMs cuánto retener una fila publicada antes de borrarla (ms).
   * @param batch       máximo de filas a borrar en ESTE DELETE (lote acotado).
   * @returns           cuántas filas borró este lote (0 o `< batch` ⇒ no quedan más viejas → el loop para).
   */
  async sweepPublished(retentionMs: number, batch: number): Promise<number> {
    const sql = `
      DELETE FROM "${this.schema}"."outbox_events"
      WHERE id IN (
        SELECT id FROM "${this.schema}"."outbox_events"
        WHERE published_at IS NOT NULL
          AND published_at < now() - ($1::double precision * interval '1 millisecond')
        ORDER BY published_at ASC, seq ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )`;
    return this.prisma.$executeRawUnsafe(sql, retentionMs, batch);
  }
}
