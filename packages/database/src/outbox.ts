/**
 * Outbox pattern lado Prisma (FOUNDATION §6, CLAUDE regla 3).
 * `enqueueOutbox` se llama DENTRO de la misma transacción que la mutación de dominio.
 * `PrismaOutboxStore` implementa el OutboxStore que el relay de @veo/events drena a Kafka.
 *
 * Cada servicio que publica eventos debe incluir este modelo en su schema.prisma:
 *   model OutboxEvent {
 *     id          String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
 *     aggregateId String   @map("aggregate_id")
 *     eventType   String   @map("event_type")
 *     envelope    Json
 *     createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz
 *     publishedAt DateTime? @map("published_at") @db.Timestamptz
 *     @@index([publishedAt, createdAt])
 *     @@map("outbox_events")
 *     @@schema("<servicio>")
 *   }
 */
import type { EventEnvelope, OutboxRecord, OutboxStore } from '@veo/events';

export const OUTBOX_PRISMA_MODEL = `model OutboxEvent {
  id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  aggregateId String    @map("aggregate_id")
  eventType   String    @map("event_type")
  envelope    Json
  createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz
  publishedAt DateTime? @map("published_at") @db.Timestamptz

  @@index([publishedAt, createdAt])
  @@map("outbox_events")
}`;

/** Delegate estructural de Prisma para el modelo OutboxEvent (write client o tx client). */
export interface OutboxDelegate {
  create(args: { data: OutboxCreateData }): Promise<unknown>;
  findMany(args: {
    where: { publishedAt: null };
    orderBy: { createdAt: 'asc' };
    take: number;
  }): Promise<OutboxRow[]>;
  updateMany(args: { where: { id: { in: string[] } }; data: { publishedAt: Date } }): Promise<unknown>;
}

interface OutboxCreateData {
  aggregateId: string;
  eventType: string;
  envelope: unknown;
}

interface OutboxRow {
  id: string;
  aggregateId: string;
  envelope: unknown;
  createdAt: Date;
  publishedAt: Date | null;
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

/** Cliente Prisma (write o de transacción) con lo que el store necesita. Estructural: no acopla a @prisma/client. */
export interface OutboxTxClient {
  outboxEvent: OutboxDelegate;
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}
export interface OutboxPrismaClient extends OutboxTxClient {
  $transaction<R>(
    fn: (tx: OutboxTxClient) => Promise<R>,
    options?: { timeout?: number; maxWait?: number },
  ): Promise<R>;
}

/**
 * Clave estable (int8 con signo) para el advisory lock del outbox, derivada del schema del servicio.
 * DISTINTA por servicio: si dos servicios comparten una misma base Postgres (dev), sus relays no se
 * bloquean entre sí. Hash FNV-1a acotado a < 2^63.
 */
export function outboxAdvisoryLockKey(schema: string): bigint {
  let h = 1469598103934665603n;
  for (let i = 0; i < schema.length; i++) {
    h ^= BigInt(schema.charCodeAt(i));
    h = (h * 1099511628211n) % 9223372036854775783n;
  }
  return h;
}

/** Implementación de OutboxStore (de @veo/events) sobre Prisma para que el relay publique a Kafka. */
export class PrismaOutboxStore implements OutboxStore {
  private readonly lockKey: bigint;

  constructor(
    private readonly prisma: OutboxPrismaClient,
    schema: string,
  ) {
    this.lockKey = outboxAdvisoryLockKey(schema);
  }

  /**
   * Drena el outbox de forma SEGURA en multi-réplica. Un `pg_try_advisory_xact_lock` por schema garantiza
   * que solo UNA réplica drene a la vez (las demás obtienen el lock en `false` → no-op este tick). El
   * fetch→publish→mark va en la MISMA transacción: si el publish a Kafka falla, rollback → las filas quedan
   * sin publicar y se reintentan (no se pierde el evento). Cierra el doble fan-out (regla 3 / BR-S05).
   * El lock (xact) se libera solo al commit/rollback.
   */
  async drainLocked(
    limit: number,
    publish: (record: OutboxRecord) => Promise<void>,
  ): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        const lock = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${this.lockKey}) AS locked`;
        if (!lock[0]?.locked) return 0; // otra réplica está drenando este outbox

        const rows = await tx.outboxEvent.findMany({
          where: { publishedAt: null },
          orderBy: { createdAt: 'asc' },
          take: limit,
        });
        if (rows.length === 0) return 0;

        const ids: string[] = [];
        for (const r of rows) {
          await publish({
            id: r.id,
            aggregateId: r.aggregateId,
            envelope: r.envelope as EventEnvelope<unknown>,
            createdAt: r.createdAt,
            publishedAt: r.publishedAt,
          });
          ids.push(r.id);
        }
        await tx.outboxEvent.updateMany({
          where: { id: { in: ids } },
          data: { publishedAt: new Date() },
        });
        return ids.length;
      },
      { timeout: 15_000 },
    );
  }
}
