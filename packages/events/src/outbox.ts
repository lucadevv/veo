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

/** Puerto que el relay usa para leer/marcar pendientes (lo implementa @veo/database por servicio). */
export interface OutboxStore {
  fetchUnpublished(limit: number): Promise<OutboxRecord[]>;
  markPublished(ids: string[]): Promise<void>;
}

/**
 * Relay del outbox: bucle que drena pendientes y los publica. Llamar en un intervalo
 * (ej. cada 500ms) o disparar tras cada commit. Idempotente: republicar es seguro (dedupKey).
 */
export async function drainOutbox(
  store: OutboxStore,
  producer: KafkaEventProducer,
  batchSize = 100,
): Promise<number> {
  const pending = await store.fetchUnpublished(batchSize);
  if (pending.length === 0) return 0;
  const published: string[] = [];
  for (const record of pending) {
    // El envelope se persistió genérico; en publicación T se resuelve por eventType del registro.
    await producer.publish(
      record.envelope as EventEnvelope<EventPayload<EventType>>,
      record.aggregateId,
    );
    published.push(record.id);
  }
  await store.markPublished(published);
  return published.length;
}
