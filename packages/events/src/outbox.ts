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
 * Puerto que el relay usa para drenar pendientes (lo implementa @veo/database por servicio).
 * `drainLocked` encapsula el lock multi-réplica + la transacción fetch→publish→mark, recibiendo el
 * `publish` como callback (la publicación a Kafka vive en el relay; el lock/tx en la impl Prisma).
 */
export interface OutboxStore {
  drainLocked(limit: number, publish: (record: OutboxRecord) => Promise<void>): Promise<number>;
}

/**
 * Relay del outbox: drena pendientes y los publica, SEGURO en multi-réplica (advisory lock por servicio
 * dentro de la impl: solo una réplica drena a la vez). Llamar en un intervalo (ej. cada 500ms). Idempotente.
 */
export async function drainOutbox(
  store: OutboxStore,
  producer: KafkaEventProducer,
  batchSize = 100,
): Promise<number> {
  return store.drainLocked(batchSize, (record) =>
    // El envelope se persistió genérico; en publicación T se resuelve por eventType del registro.
    producer.publish(record.envelope as EventEnvelope<EventPayload<EventType>>, record.aggregateId),
  );
}
