/**
 * Wrappers tipados sobre kafkajs.
 * - KafkaEventProducer.publish(envelope) valida el payload con el registro antes de enviar.
 * - KafkaEventConsumer.on(eventType, handler) valida al recibir y descarta lo inválido (a DLQ-log).
 */
import { Kafka, type Producer, type Consumer, type KafkaConfig, logLevel } from 'kafkajs';
import {
  domainEventsTotal,
  EventResult,
  UNKNOWN_EVENT,
  runWithExtractedTraceparent,
} from '@veo/observability';
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
    // NOTA: si schema.parse lanza es un BUG del caller (payload mal armado), no un publish fallido.
    // Lo dejamos propagar SIN métrica — el scope de la métrica es el send() a Kafka, no la validación.
    if (schema) schema.parse(envelope.payload);
    try {
      // RESTAURA el contexto de traza capturado en el enqueue (request). Envolver el `send` en el
      // contexto del request hace que la auto-instrumentación de kafkajs cree el span del publish como
      // HIJO del request original (no del tick del relay) e inyecte el `traceparent` correcto en los
      // headers Kafka → el consumer continúa la traza ORIGINAL. Sin traceparent (envelope viejo / sin
      // OTel) ejecuta el `send` tal cual (camino histórico). NO inyectamos el header a mano: lo hace la
      // auto-instrumentación de kafkajs a partir del contexto activo (no duplicar).
      await runWithExtractedTraceparent(envelope.traceparent, () =>
        this.producer.send({
          topic: topicForEvent(envelope.eventType),
          messages: [
            { key, value: JSON.stringify(envelope), headers: { eventType: envelope.eventType } },
          ],
        }),
      );
    } catch (err) {
      domainEventsTotal.inc({ event: envelope.eventType, result: EventResult.PUBLISH_FAILED });
      throw err; // re-lanzar: el outbox relay / caller decide retry. No tragar.
    }
    domainEventsTotal.inc({ event: envelope.eventType, result: EventResult.PUBLISHED });
  }
}

export type EventHandler = (envelope: EventEnvelope<unknown>) => Promise<void>;

/**
 * Opciones de un KafkaEventConsumer.
 *
 * `partitionsConsumedConcurrently` es OPCIONAL y POR-CONSUMER (no un global mágico): default 1 → cada
 * consumer que NO la sube conserva el comportamiento histórico (una partición a la vez, orden estricto).
 * Subirla paraleliza SOLO particiones DISTINTAS — kafkajs sigue procesando CADA partición SERIAL —, así
 * que la serialización per-KEY (per-aggregate) se PRESERVA: un mismo key cae siempre en la misma partición
 * y sus mensajes se procesan en orden. La sube el consumer del firehose de GPS (dispatch, key=driverId)
 * para escalar a 1000 conductores concurrentes SIN romper el RMW per-driver del hot-index.
 */
export interface KafkaEventConsumerOptions {
  partitionsConsumedConcurrently?: number;
}

/** Normaliza la concurrencia a un entero >= 1 (default 1). Tolera undefined / '' / valores inválidos. */
function normalizePartitionConcurrency(value: number | undefined): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

export class KafkaEventConsumer {
  private readonly consumer: Consumer;
  private readonly handlers = new Map<string, EventHandler>();
  private readonly topics = new Set<string>();
  /** Nº de particiones procesadas EN PARALELO (default 1 = orden estricto por partición). */
  private readonly partitionsConsumedConcurrently: number;

  constructor(kafka: Kafka, groupId: string, options?: KafkaEventConsumerOptions) {
    this.consumer = kafka.consumer({ groupId, sessionTimeout: 30_000 });
    this.partitionsConsumedConcurrently = normalizePartitionConcurrency(
      options?.partitionsConsumedConcurrently,
    );
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
      // ESCALA: procesa hasta N particiones EN PARALELO (default 1). Solo paraleliza particiones
      // DISTINTAS; cada partición sigue serial → el orden per-KEY se preserva (ver KafkaEventConsumerOptions).
      partitionsConsumedConcurrently: this.partitionsConsumedConcurrently,
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
          // POISON: body no-JSON, sin eventType confiable → label `event` = UNKNOWN_EVENT.
          domainEventsTotal.inc({ event: UNKNOWN_EVENT, result: EventResult.POISON });
          return; // skip → kafkajs commitea el offset y la partición AVANZA (no crash-loop).
        }
        const parsed = envelopeSchema.safeParse(raw);
        if (!parsed.success) {
          // INVALID: envelope corrupto, eventType no confiable → label `event` = UNKNOWN_EVENT.
          domainEventsTotal.inc({ event: UNKNOWN_EVENT, result: EventResult.INVALID });
          return; // ignorar (el caller debe loguear via interceptor)
        }
        const envelope = parsed.data as EventEnvelope<unknown>;
        const handler = this.handlers.get(envelope.eventType);
        // SIN handler → SIN métrica: en topics compartidos cada consumer recibe TODOS los eventos
        // del topic; contar los no-manejados inflaría la métrica con eventos ajenos a este consumer.
        if (!handler) return;
        const payloadSchema = schemaForEvent(envelope.eventType);
        if (payloadSchema && !payloadSchema.safeParse(envelope.payload).success) {
          // INVALID para un evento CON handler: payload no matchea su schema → eventType SÍ confiable.
          domainEventsTotal.inc({ event: envelope.eventType, result: EventResult.INVALID });
          return;
        }
        try {
          await handler(envelope);
        } catch (err) {
          // ERROR de transporte: el handler falló (DB caída, timeout...). Contamos y RE-LANZAMOS
          // para preservar el invariante: eachMessage rechaza → kafkajs NO commitea → reintenta.
          domainEventsTotal.inc({ event: envelope.eventType, result: EventResult.ERROR });
          throw err;
        }
        domainEventsTotal.inc({ event: envelope.eventType, result: EventResult.CONSUMED });
      },
    });
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect();
  }
}
