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

/** Implementación de OutboxStore (de @veo/events) sobre Prisma para que el relay publique a Kafka. */
export class PrismaOutboxStore implements OutboxStore {
  constructor(private readonly delegate: OutboxDelegate) {}

  async fetchUnpublished(limit: number): Promise<OutboxRecord[]> {
    const rows = await this.delegate.findMany({
      where: { publishedAt: null },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      aggregateId: r.aggregateId,
      envelope: r.envelope as EventEnvelope<unknown>,
      createdAt: r.createdAt,
      publishedAt: r.publishedAt,
    }));
  }

  async markPublished(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.delegate.updateMany({ where: { id: { in: ids } }, data: { publishedAt: new Date() } });
  }
}
