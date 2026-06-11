/**
 * @veo/events/nest — bootstrap NestJS de consumers Kafka (esqueleto promovido, Lote P6).
 *
 * SUB-EXPORT deliberado: el entry principal (`@veo/events`) sigue PURO (zod + kafkajs, sin Nest).
 * Solo los servicios NestJS importan este módulo (`import { … } from '@veo/events/nest'`).
 *
 * Qué promueve (antes re-armado a mano en cada servicio):
 *  1. `KafkaConsumerBootstrap` — el bootstrap de TODO consumer Kafka: createKafka +
 *     new KafkaEventConsumer(kafka, groupId) + registro de handlers + onModuleInit/onModuleDestroy.
 *  2. `ErasureConsumerBase` — el esqueleto del consumer de derecho al olvido (Ley 29733, BR-S06),
 *     gemelo de ~100 líneas en 5 servicios: valida el payload contra el registro central,
 *     deduplica por `eventId` (marca DESPUÉS del éxito), loguea y relanza para que kafkajs
 *     reintente. La LÓGICA de borrado sigue siendo de cada dominio (config declarativa).
 *
 * REGLA DE ORO (memoria de incidente real): un groupId = UN KafkaEventConsumer con TODOS sus
 * eventos encadenados. En kafkajs 2.2.4 el líder del consumer group asigna particiones usando SOLO
 * su propia lista de topics (round-robin ignora la suscripción por miembro): dos consumers en el
 * MISMO groupId suscritos a topics DISTINTOS dejan particiones SIN asignar según quién gane la
 * elección de líder → eventos estancados. Por eso acá el registro tiene UN ÚNICO punto: el record
 * que devuelve `handlers()` — todos los eventos del group entran juntos y el bug es imposible.
 */
import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createKafka, KafkaEventConsumer, type EventHandler } from './kafka.js';
import { processEventOnce, type DedupRedis, type EventDedupOptions } from './dedup.js';
import { schemaForEvent, type EventPayload, type EventType } from './schemas.js';
import type { EventEnvelope } from './envelope.js';

export interface KafkaConsumerBootstrapOptions {
  /** clientId de kafkajs (el nombre del servicio). */
  clientId: string;
  /** Brokers (KAFKA_BROKERS ya parseado). */
  brokers: string[];
  /**
   * REGLA DE ORO: un groupId = UN consumer (esta clase) con TODOS sus eventos en `handlers()`.
   * Jamás instanciar dos consumers con el mismo groupId y topics distintos (ver header).
   */
  groupId: string;
  /** Consumir desde el principio del topic. Default: false (igual que KafkaEventConsumer.start). */
  fromBeginning?: boolean;
}

/**
 * Bootstrap base de un consumer Kafka NestJS: arma kafka + consumer en el constructor, registra
 * los handlers y arranca en onModuleInit, desconecta en onModuleDestroy.
 *
 * El subclase declara la config: `handlers()` (ÚNICO punto de registro del group) y
 * `subscriptionLog()` (mensaje a loguear una vez suscrito, derivado de los eventos registrados
 * para que log y suscripción no puedan divergir — cero double-source).
 */
export abstract class KafkaConsumerBootstrap implements OnModuleInit, OnModuleDestroy {
  /** Logger con el nombre de la clase concreta (idéntico a `new Logger(X.name)` por servicio). */
  protected readonly logger = new Logger(this.constructor.name);
  /** El ÚNICO KafkaEventConsumer del group. Nombre estable: algunos specs lo sustituyen por dobles. */
  private readonly consumer: KafkaEventConsumer;
  private readonly fromBeginning: boolean;

  protected constructor(options: KafkaConsumerBootstrapOptions) {
    this.consumer = new KafkaEventConsumer(createKafka(options), options.groupId);
    this.fromBeginning = options.fromBeginning ?? false;
  }

  /** TODOS los eventos del groupId, en un solo record `{ evento: handler }` (regla de oro). */
  protected abstract handlers(): Readonly<Record<string, EventHandler>>;

  /** Mensaje a loguear tras suscribirse; recibe los eventos registrados (en orden de registro). */
  protected abstract subscriptionLog(eventTypes: readonly string[]): string;

  async onModuleInit(): Promise<void> {
    const handlers = this.handlers();
    for (const [eventType, handler] of Object.entries(handlers)) {
      this.consumer.on(eventType, handler);
    }
    await this.consumer.start(this.fromBeginning);
    this.logger.log(this.subscriptionLog(Object.keys(handlers)));
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.stop();
  }
}

/** Contexto estructurado + mensaje del log de error de un handler de erasure. */
export interface ErasureErrorLog {
  /** Campos estructurados que acompañan al `err` (p.ej. `{ userId }`). */
  context: Record<string, unknown>;
  message: string;
}

/**
 * Config declarativa de UN evento de la cascada de borrado. La LÓGICA de borrado es del dominio
 * de cada servicio; acá solo se declara qué ejecutar y qué loguear.
 */
export interface ErasureEventHandler<T extends EventType> {
  /**
   * Borra/anonimiza la PII del dominio. DEBE ser idempotente (contrato de processEventOnce: la
   * ventana GET→SET no es atómica). Devuelve el mensaje de éxito a loguear, o void para no
   * loguear (el esqueleto lo emite DESPUÉS de marcar el dedup, y solo en la primera ejecución).
   */
  erase(payload: EventPayload<T>): Promise<string | void>;
  /** Log estructurado del fallo; el esqueleto relanza después para que kafkajs reintente. */
  logError(payload: EventPayload<T>): ErasureErrorLog;
}

/** Un groupId de erasure = UN record con TODOS sus eventos (único punto de registro). */
export type ErasureHandlers = { readonly [T in EventType]?: ErasureEventHandler<T> };

/** Dedup por eventId en Redis (opcional: si el borrado es sobre-escritura determinista, omitir). */
export interface ErasureDedupConfig {
  redis: DedupRedis;
  options: EventDedupOptions;
}

/**
 * Esqueleto del consumer de derecho al olvido (user.deleted / trip.pii_erased). Por evento:
 *  1. Valida el payload contra el registro central; inválido → warn + ignorar (defensa en
 *     profundidad: KafkaEventConsumer ya descarta payloads inválidos antes del handler).
 *  2. Ejecuta el borrado con dedup por `eventId` (si está configurado) marcado DESPUÉS del
 *     éxito: un fallo NO escribe la marca y kafkajs reintenta sin perder la señal.
 *  3. Loguea el éxito (si el handler devolvió mensaje) solo en la primera ejecución.
 *  4. Ante error: log estructurado + relanzar (no-ack/retry lo gestiona kafkajs).
 */
export abstract class ErasureConsumerBase extends KafkaConsumerBootstrap {
  private readonly dedup?: ErasureDedupConfig;

  protected constructor(options: KafkaConsumerBootstrapOptions, dedup?: ErasureDedupConfig) {
    super(options);
    this.dedup = dedup;
  }

  /** Config declarativa del group de erasure: TODOS sus eventos en un solo record. */
  protected abstract erasureHandlers(): ErasureHandlers;

  protected override handlers(): Readonly<Record<string, EventHandler>> {
    const handlers: Record<string, EventHandler> = {};
    for (const eventType of Object.keys(this.erasureHandlers()) as EventType[]) {
      handlers[eventType] = (envelope) => this.processErasureEvent(eventType, envelope);
    }
    return handlers;
  }

  protected override subscriptionLog(eventTypes: readonly string[]): string {
    // ', ' entre todos y ' y ' SOLO entre los dos últimos. Para los groups actuales (1-2 eventos)
    // produce EXACTAMENTE el texto histórico de join(' y '); con 3+ ya no degenera en 'a y b y c'.
    const last = eventTypes[eventTypes.length - 1] ?? '';
    const head = eventTypes.slice(0, -1);
    const list = head.length === 0 ? last : `${head.join(', ')} y ${last}`;
    return `Suscrito a ${list} (derecho al olvido)`;
  }

  /** Corre el esqueleto completo (validar → dedup → borrar → loguear) para un evento. */
  protected async processErasureEvent<T extends EventType>(
    eventType: T,
    envelope: EventEnvelope<unknown>,
  ): Promise<void> {
    const handler = this.erasureHandlers()[eventType];
    if (!handler) return; // evento no declarado en el record (imposible vía handlers())

    const parsed = schemaForEvent(eventType)?.safeParse(envelope.payload);
    if (!parsed?.success) {
      this.logger.warn(`${eventType} con payload inválido (eventId=${envelope.eventId}); ignorado`);
      return;
    }
    const payload = parsed.data as EventPayload<T>;

    try {
      const successLog = await this.eraseOnce(envelope.eventId, () => handler.erase(payload));
      if (typeof successLog === 'string') this.logger.log(successLog);
    } catch (err) {
      // No-ack/retry lo gestiona kafkajs; el dedup NO se marcó, el reintento volverá a borrar.
      const { context, message } = handler.logError(payload);
      this.logger.error({ err, ...context }, message);
      throw err;
    }
  }

  /**
   * Ejecuta el borrado con dedup si está configurado (marca DESPUÉS del éxito). Devuelve el
   * mensaje de éxito del handler, o undefined si el evento ya había sido procesado.
   */
  private async eraseOnce(
    eventId: string,
    erase: () => Promise<string | void>,
  ): Promise<string | void | undefined> {
    if (!this.dedup) return erase();
    const outcome = await processEventOnce(this.dedup.redis, this.dedup.options, eventId, erase);
    return outcome.executed ? outcome.result : undefined;
  }
}
