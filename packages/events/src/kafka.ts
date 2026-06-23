/**
 * Wrappers tipados sobre kafkajs.
 * - KafkaEventProducer.publish(envelope) valida el payload con el registro antes de enviar.
 * - KafkaEventConsumer.on(eventType, handler) valida al recibir y descarta lo inválido (a DLQ-log).
 */
import { Kafka, type Producer, type Consumer, type KafkaConfig, logLevel } from 'kafkajs';
import { type EventEnvelope, envelopeSchema } from './envelope.js';
import { schemaForEvent, topicForEvent, type EventType, type EventPayload } from './schemas.js';

export interface EventBusOptions {
  clientId: string;
  brokers: string[];
  /** groupId para consumir. Si no se consume, omitir. */
  groupId?: string;
  ssl?: KafkaConfig['ssl'];
  sasl?: KafkaConfig['sasl'];
}

export function createKafka(opts: EventBusOptions): Kafka {
  return new Kafka({
    clientId: opts.clientId,
    brokers: opts.brokers,
    ssl: opts.ssl,
    sasl: opts.sasl,
    logLevel: logLevel.WARN,
    retry: { retries: 8, initialRetryTime: 300 },
  });
}

export class KafkaEventProducer {
  private readonly producer: Producer;
  constructor(kafka: Kafka) {
    this.producer = kafka.producer({ allowAutoTopicCreation: true, idempotent: true });
  }
  async connect(): Promise<void> {
    await this.producer.connect();
  }
  async disconnect(): Promise<void> {
    await this.producer.disconnect();
  }

  /** Publica un envelope. Valida el payload contra el registro (si existe). `key` ordena por entidad. */
  async publish<T extends EventType>(
    envelope: EventEnvelope<EventPayload<T>>,
    key: string,
  ): Promise<void> {
    const schema = schemaForEvent(envelope.eventType);
    if (schema) schema.parse(envelope.payload);
    await this.producer.send({
      topic: topicForEvent(envelope.eventType),
      messages: [
        { key, value: JSON.stringify(envelope), headers: { eventType: envelope.eventType } },
      ],
    });
  }
}

export type EventHandler = (envelope: EventEnvelope<unknown>) => Promise<void>;

export class KafkaEventConsumer {
  private readonly consumer: Consumer;
  private readonly handlers = new Map<string, EventHandler>();
  private readonly topics = new Set<string>();

  constructor(kafka: Kafka, groupId: string) {
    this.consumer = kafka.consumer({ groupId, sessionTimeout: 30_000 });
  }

  /** Registra un handler para un eventType y se suscribe a su topic. */
  on(eventType: string, handler: EventHandler): this {
    this.handlers.set(eventType, handler);
    this.topics.add(topicForEvent(eventType));
    return this;
  }

  async start(fromBeginning = false): Promise<void> {
    await this.consumer.connect();
    for (const topic of this.topics) {
      await this.consumer.subscribe({ topic, fromBeginning });
    }
    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        if (!message.value) return;
        // POISON-SAFE PARSE (incidente dev 2026-06 · ver poison.ts): un `value` NO-JSON (truncado, binario,
        // otro producer) lanza SyntaxError en JSON.parse ANTES del safeParse del envelope. Si eso se propagara,
        // eachMessage rechazaría → kafkajs NO commitea el offset → re-entrega el MISMO mensaje infinitamente
        // (head-of-line block: la partición se estanca). Un body no-parseable es PERMANENTE (reintentar da el
        // mismo error): MISMO criterio "log & skip" que ya aplica al safeParse del envelope y al poison handler.
        // Logueamos topic/partition/offset para diagnóstico SIN volcar el body crudo (puede portar PII/datos).
        let raw: unknown;
        try {
          raw = JSON.parse(message.value.toString());
        } catch {
          // eslint-disable-next-line no-console -- sin logger inyectado en esta capa; warn estructurado mínimo.
          console.warn(
            `[KafkaEventConsumer] body no-JSON descartado (poison): topic=${topic} partition=${partition} offset=${message.offset}`,
          );
          return; // skip → kafkajs commitea el offset y la partición AVANZA (no crash-loop).
        }
        const parsed = envelopeSchema.safeParse(raw);
        if (!parsed.success) return; // envelope corrupto → ignorar (el caller debe loguear via interceptor)
        const envelope = parsed.data as EventEnvelope<unknown>;
        const handler = this.handlers.get(envelope.eventType);
        if (!handler) return;
        const payloadSchema = schemaForEvent(envelope.eventType);
        if (payloadSchema && !payloadSchema.safeParse(envelope.payload).success) return;
        await handler(envelope);
      },
    });
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect();
  }
}
