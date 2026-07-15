/**
 * Tests del KafkaEventConsumer — foco en la ROBUSTEZ del `eachMessage` (FIX poison del parse).
 *
 * CAUSA RAÍZ cubierta (incidente dev 2026-06 · ver poison.ts): un `message.value` NO-JSON (truncado,
 * binario, otro producer) lanzaba SyntaxError en `JSON.parse` ANTES del safeParse del envelope. Si la
 * promesa de eachMessage rechaza, kafkajs NO commitea el offset → re-entrega el MISMO mensaje
 * infinitamente (head-of-line block: la partición se estanca). El consumer compartido lo afecta a TODOS
 * los servicios (trip/identity/payment/media). El fix envuelve el parse en try/catch → log & skip.
 *
 * No se conecta a un broker real: se MOCKEA kafkajs para capturar el callback `eachMessage` que el
 * consumer registra en `consumer.run(...)` y se lo invoca directo con mensajes sintéticos.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventEnvelope } from './envelope.js';

// Captura el callback eachMessage que el consumer registra, para invocarlo a mano.
type EachMessage = (arg: {
  topic: string;
  partition: number;
  message: { value: Buffer | null; offset: string };
}) => Promise<void>;

let captured: EachMessage | undefined;

const consumerMock = {
  connect: vi.fn(async () => undefined),
  subscribe: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  run: vi.fn(async ({ eachMessage }: { eachMessage: EachMessage }) => {
    captured = eachMessage;
  }),
};

// Producer mock con send/connect/disconnect espiables (antes devolvía `{}`); el producer base
// instrumenta `result:published` tras un send que resuelve, así que el test de publish lo necesita.
const producerMock = {
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  send: vi.fn(async () => undefined),
};

vi.mock('kafkajs', () => ({
  Kafka: class {
    consumer() {
      return consumerMock;
    }
    producer() {
      return producerMock;
    }
  },
  logLevel: { WARN: 4 },
}));

// Mock de @veo/observability: el counter real intentaría registrarse en el Registry compartido.
// Lo reemplazamos por un `.inc` espiable; EventResult/UNKNOWN_EVENT conservan los valores REALES.
const incSpy = vi.fn();
vi.mock('@veo/observability', () => ({
  domainEventsTotal: { inc: incSpy },
  // Propagación de traza a través del outbox: en este spec (sin OTel) degradan a no-op exacto —
  // captureTraceparent → undefined (no setea el campo), runWithExtractedTraceparent → ejecuta fn tal cual.
  captureTraceparent: (): string | undefined => undefined,
  runWithExtractedTraceparent: <R>(_tp: string | undefined, fn: () => R): R => fn(),
  EventResult: {
    CONSUMED: 'consumed',
    ERROR: 'error',
    INVALID: 'invalid',
    POISON: 'poison',
    PUBLISHED: 'published',
    PUBLISH_FAILED: 'publish_failed',
    UNKNOWN: 'unknown',
  },
  // Valores REALES de negocio (deben coincidir con @veo/observability): el test de disjunción los usa
  // para verificar que un label de negocio NO colisiona con el transporte que emite el base.
  BusinessEventResult: {
    EMITTED: 'emitted',
    NO_DRIVER: 'no_driver',
    DELIVERY_FAILED: 'delivery_failed',
    REJECTED: 'rejected',
    BAD_REQUEST: 'bad_request',
    OK: 'ok',
    RECORDED: 'recorded',
    DUPLICATE: 'duplicate',
    RECONCILED: 'reconciled',
    SKIPPED: 'skipped',
  },
  UNKNOWN_EVENT: 'unknown',
}));

// Import DESPUÉS del mock (vi.mock se hoistea, pero el import dinámico deja claro el orden).
const { KafkaEventConsumer, KafkaEventProducer, createKafka } = await import('./kafka.js');
const { createEnvelope } = await import('./envelope.js');
// Importados DEL MOCK (arriba): domainEventsTotal.inc === incSpy, así el handler de negocio del test
// de disjunción y el base escriben en el MISMO spy (verificamos ambas series en una sola aserción).
const { EventResult, BusinessEventResult, domainEventsTotal } = await import('@veo/observability');

function makeConsumer() {
  const kafka = createKafka({ clientId: 'test', brokers: ['localhost:9092'] });
  return new KafkaEventConsumer(kafka, 'test-group');
}

describe('KafkaEventConsumer · eachMessage poison-safe parse', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    captured = undefined;
    consumerMock.run.mockClear();
    incSpy.mockClear();
    producerMock.send.mockClear();
    producerMock.send.mockResolvedValue(undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('un body NO-JSON NO lanza, loguea (warn) y avanza (skip) — la partición no se estanca', async () => {
    const handler = vi.fn(async (_e: EventEnvelope<unknown>): Promise<void> => undefined);
    const consumer = makeConsumer().on('booking.confirmed', handler);
    await consumer.start();
    expect(captured).toBeDefined();

    // Body NO-parseable (binario/truncado): JSON.parse lanzaría SyntaxError.
    await expect(
      captured!({
        topic: 'booking',
        partition: 3,
        message: { value: Buffer.from([0xff, 0xfe, 0x00, 0x01]), offset: '42' },
      }),
    ).resolves.toBeUndefined(); // NO rechaza → kafkajs commitea el offset y avanza.

    expect(handler).not.toHaveBeenCalled(); // el mensaje veneno se descartó, no llegó al handler.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = String(warnSpy.mock.calls[0]?.[0]);
    expect(logged).toContain('topic=booking');
    expect(logged).toContain('partition=3');
    expect(logged).toContain('offset=42');
    expect(logged).not.toContain('\xff'); // no se volcó el body crudo.
  });

  it('un string JSON-válido pero NO-objeto (envelope corrupto) tampoco lanza ni llama al handler', async () => {
    const handler = vi.fn(async (_e: EventEnvelope<unknown>): Promise<void> => undefined);
    const consumer = makeConsumer().on('booking.confirmed', handler);
    await consumer.start();

    // "123" parsea como número → safeParse del envelope falla → return silencioso (no es poison de parse).
    await expect(
      captured!({
        topic: 'booking',
        partition: 0,
        message: { value: Buffer.from('123'), offset: '7' },
      }),
    ).resolves.toBeUndefined();

    expect(handler).not.toHaveBeenCalled();
  });

  it('un mensaje VÁLIDO sigue llegando al handler (el fix es ADITIVO, no rompe el camino feliz)', async () => {
    const handler = vi.fn(async (_e: EventEnvelope<unknown>): Promise<void> => undefined);
    const consumer = makeConsumer().on('booking.confirmed', handler);
    await consumer.start();

    const envelope = createEnvelope({
      eventType: 'booking.confirmed',
      producer: 'booking-service',
      payload: {
        bookingId: 'b1',
        publishedTripId: 'pt1',
        passengerId: 'p1',
        asientos: 1,
        precioAcordado: 4500,
        paymentId: 'pay1',
        estado: 'CONFIRMADO',
      },
    });

    await captured!({
      topic: 'booking',
      partition: 0,
      message: { value: Buffer.from(JSON.stringify(envelope)), offset: '1' },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const received = handler.mock.calls[0]?.[0] as { eventType: string } | undefined;
    expect(received).toMatchObject({ eventType: 'booking.confirmed' });
  });

  it('un error LEGÍTIMO del handler (ej. DB caída) se PROPAGA (rechaza) — NO se traga: kafkajs reintenta y el evento NO se pierde', async () => {
    // INVARIANTE BLINDADO: el try/catch del eachMessage envuelve SOLO el JSON.parse (poison del body). El
    // handler se invoca DESPUÉS, FUERA del try/catch. Por eso un fallo TRANSITORIO del handler (DB caída,
    // timeout) debe PROPAGARSE → eachMessage rechaza → kafkajs NO commitea el offset → reintenta el mismo
    // mensaje (no se pierde el evento, ej. un pago). Contraste con el body no-JSON (PERMANENTE), que SÍ se
    // traga (log & skip). Si alguien ENSANCHA el try/catch para abrazar `await handler(...)`, este error se
    // tragaría → la promesa resolvería → ESTE test FALLA (rejects deja de cumplirse). Esa es la red.
    const dbDown = new Error('DB caída');
    const handler = vi.fn(async (_e: EventEnvelope<unknown>): Promise<void> => {
      throw dbDown;
    });
    const consumer = makeConsumer().on('booking.confirmed', handler);
    await consumer.start();

    const envelope = createEnvelope({
      eventType: 'booking.confirmed',
      producer: 'booking-service',
      payload: {
        bookingId: 'b1',
        publishedTripId: 'pt1',
        passengerId: 'p1',
        asientos: 1,
        precioAcordado: 4500,
        paymentId: 'pay1',
        estado: 'CONFIRMADO',
      },
    });

    await expect(
      captured!({
        topic: 'booking',
        partition: 0,
        message: { value: Buffer.from(JSON.stringify(envelope)), offset: '99' },
      }),
    ).rejects.toThrow(dbDown); // PROPAGA el error del handler — NO lo traga.

    expect(handler).toHaveBeenCalledTimes(1); // sí llegó al handler (no es poison de parse).
  });
});

/**
 * Instrumentación de `domain_events_total{event,result}` en la capa BASE (consumer + producer).
 * El counter está mockeado (incSpy) — verificamos el CONTRATO de labels, no el Registry real.
 */
describe('KafkaEventConsumer · métrica domain_events_total (transporte)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  const validPayload = {
    bookingId: 'b1',
    publishedTripId: 'pt1',
    passengerId: 'p1',
    asientos: 1,
    precioAcordado: 4500,
    paymentId: 'pay1',
    estado: 'CONFIRMADO' as const,
  };

  beforeEach(() => {
    captured = undefined;
    consumerMock.run.mockClear();
    incSpy.mockClear();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('handler OK → inc { event, result:"consumed" } exactamente una vez', async () => {
    const handler = vi.fn(async (_e: EventEnvelope<unknown>): Promise<void> => undefined);
    const consumer = makeConsumer().on('booking.confirmed', handler);
    await consumer.start();

    const envelope = createEnvelope({
      eventType: 'booking.confirmed',
      producer: 'booking-service',
      payload: validPayload,
    });

    await captured!({
      topic: 'booking',
      partition: 0,
      message: { value: Buffer.from(JSON.stringify(envelope)), offset: '1' },
    });

    expect(incSpy).toHaveBeenCalledTimes(1);
    expect(incSpy).toHaveBeenCalledWith({ event: 'booking.confirmed', result: 'consumed' });
  });

  it('handler lanza → inc { event, result:"error" } Y la promesa RECHAZA (re-throw preservado)', async () => {
    const boom = new Error('DB caída');
    const handler = vi.fn(async (_e: EventEnvelope<unknown>): Promise<void> => {
      throw boom;
    });
    const consumer = makeConsumer().on('booking.confirmed', handler);
    await consumer.start();

    const envelope = createEnvelope({
      eventType: 'booking.confirmed',
      producer: 'booking-service',
      payload: validPayload,
    });

    await expect(
      captured!({
        topic: 'booking',
        partition: 0,
        message: { value: Buffer.from(JSON.stringify(envelope)), offset: '5' },
      }),
    ).rejects.toThrow(boom);

    expect(incSpy).toHaveBeenCalledWith({ event: 'booking.confirmed', result: 'error' });
    // NO se contó consumed (el camino feliz no se alcanzó).
    expect(incSpy).not.toHaveBeenCalledWith({ event: 'booking.confirmed', result: 'consumed' });
  });

  it('evento SIN handler (otro evento del topic) → NO infla (ni consumed ni error)', async () => {
    const handler = vi.fn(async (_e: EventEnvelope<unknown>): Promise<void> => undefined);
    // Este consumer SÓLO maneja booking.confirmed; recibe booking.cancelled (ajeno) por el topic.
    const consumer = makeConsumer().on('booking.confirmed', handler);
    await consumer.start();

    const envelope = createEnvelope({
      eventType: 'booking.cancelled',
      producer: 'booking-service',
      payload: { bookingId: 'b1', motivo: 'PASAJERO' },
    });

    await captured!({
      topic: 'booking',
      partition: 0,
      message: { value: Buffer.from(JSON.stringify(envelope)), offset: '2' },
    });

    expect(handler).not.toHaveBeenCalled();
    expect(incSpy).not.toHaveBeenCalled(); // SIN métrica: no maneja este evento, no lo cuenta.
  });

  it('body no-JSON (poison) → inc { event:"unknown", result:"poison" }', async () => {
    const handler = vi.fn(async (_e: EventEnvelope<unknown>): Promise<void> => undefined);
    const consumer = makeConsumer().on('booking.confirmed', handler);
    await consumer.start();

    await captured!({
      topic: 'booking',
      partition: 3,
      message: { value: Buffer.from([0xff, 0xfe, 0x00, 0x01]), offset: '42' },
    });

    expect(incSpy).toHaveBeenCalledTimes(1);
    expect(incSpy).toHaveBeenCalledWith({ event: 'unknown', result: 'poison' });
  });
});

/**
 * FIX 3 · DISJUNCIÓN transporte↔negocio A TRAVÉS DEL BASE (no en aislamiento del handler).
 *
 * El bug que ancla este test: los handlers de negocio (driver-bff fan-out realtime, dispatch skip de
 * data permanente) emiten su PROPIO `result`. Los specs de esos handlers los prueban EN AISLAMIENTO
 * (llaman al método del service directo) → NO cazan que el `eachMessage` del base emite CONSUMED
 * (transporte) ENCIMA del label de negocio. Antes del fix los handlers reusaban 'error'/'poison' →
 * el MISMO mensaje quedaba contado con dos significados contradictorios de `result`.
 *
 * Acá ejercitamos un handler que emite un label de NEGOCIO (DELIVERY_FAILED / REJECTED) A TRAVÉS del
 * `eachMessage` real del base (un mensaje VÁLIDO por el camino feliz) y verificamos que conviven DOS
 * series DISJUNTAS de `domain_events_total{event,result}`: la de negocio (la emite el handler) Y la de
 * transporte CONSUMED (la emite el base, porque el handler retornó normal). Si alguien reintrodujera un
 * label de negocio que colisione con EventResult, las series se solaparían y este test cazaría la ambigüedad.
 */
describe('KafkaEventConsumer · disjunción transporte↔negocio (handler emite negocio A TRAVÉS del base)', () => {
  const validPayload = {
    bookingId: 'b1',
    publishedTripId: 'pt1',
    passengerId: 'p1',
    asientos: 1,
    precioAcordado: 4500,
    paymentId: 'pay1',
    estado: 'CONFIRMADO' as const,
  };

  beforeEach(() => {
    captured = undefined;
    consumerMock.run.mockClear();
    incSpy.mockClear();
  });

  it('handler emite NEGOCIO (delivery_failed, swallow best-effort) y RETORNA normal → el base cuenta CONSUMED: dos series DISJUNTAS', async () => {
    // Réplica fiel del patrón driver-bff: el fan-out realtime falla, el handler TRAGA el error (best-effort:
    // el cliente re-sincroniza al reconectar), emite su label de negocio y RETORNA normal (no relanza).
    const handler = vi.fn(async (e: EventEnvelope<unknown>): Promise<void> => {
      domainEventsTotal.inc({ event: e.eventType, result: BusinessEventResult.DELIVERY_FAILED });
      // retorna normal → el offset se commitea → el base emite CONSUMED encima.
    });
    const consumer = makeConsumer().on('booking.confirmed', handler);
    await consumer.start();

    const envelope = createEnvelope({
      eventType: 'booking.confirmed',
      producer: 'booking-service',
      payload: validPayload,
    });

    await expect(
      captured!({
        topic: 'booking',
        partition: 0,
        message: { value: Buffer.from(JSON.stringify(envelope)), offset: '11' },
      }),
    ).resolves.toBeUndefined(); // NO rechaza: el handler tragó → kafkajs commitea.

    // NEGOCIO: el handler emitió delivery_failed (su decisión: falló la entrega al socket).
    expect(incSpy).toHaveBeenCalledWith({
      event: 'booking.confirmed',
      result: 'delivery_failed',
    });
    // TRANSPORTE: el base emitió CONSUMED encima (el mensaje Kafka se procesó OK).
    expect(incSpy).toHaveBeenCalledWith({ event: 'booking.confirmed', result: 'consumed' });
    // DISJUNCIÓN: dos series con `result` DISTINTO (negocio ≠ transporte). NUNCA el mismo valor dos veces.
    expect(incSpy).toHaveBeenCalledTimes(2);
    expect('delivery_failed').not.toBe('consumed');
    // El handler de negocio JAMÁS reusa un valor de EventResult (transporte). DERIVAMOS los valores de
    // transporte de `Object.values(EventResult)` — NO los hardcodeamos: así el test NUNCA omite uno (ej.
    // UNKNOWN) ni queda stale si el const crece. UNKNOWN_EVENT es el sentinela de `event`, no de `result`.
    const transportValues = Object.values(EventResult);
    expect(transportValues).not.toContain(BusinessEventResult.DELIVERY_FAILED);
    expect(transportValues).not.toContain(BusinessEventResult.REJECTED);
  });

  it('handler emite NEGOCIO (rejected, skip de data mala) y RETORNA normal → el base cuenta CONSUMED, no POISON: series DISJUNTAS', async () => {
    // Réplica del patrón dispatch: el handler RECHAZA data permanentemente mala (ej. UUID inválido),
    // la descarta (skip correcto, no relanza) y emite REJECTED. NO es el POISON del base (body no-JSON):
    // el evento SÍ era JSON válido. El base, como el handler retornó normal, emite CONSUMED.
    const handler = vi.fn(async (e: EventEnvelope<unknown>): Promise<void> => {
      domainEventsTotal.inc({ event: e.eventType, result: BusinessEventResult.REJECTED });
    });
    const consumer = makeConsumer().on('booking.confirmed', handler);
    await consumer.start();

    const envelope = createEnvelope({
      eventType: 'booking.confirmed',
      producer: 'booking-service',
      payload: validPayload,
    });

    await captured!({
      topic: 'booking',
      partition: 0,
      message: { value: Buffer.from(JSON.stringify(envelope)), offset: '12' },
    });

    expect(incSpy).toHaveBeenCalledWith({ event: 'booking.confirmed', result: 'rejected' });
    expect(incSpy).toHaveBeenCalledWith({ event: 'booking.confirmed', result: 'consumed' });
    // REJECTED (negocio) ≠ POISON (transporte): el base NUNCA contó poison para un body JSON-válido.
    expect(incSpy).not.toHaveBeenCalledWith({ event: 'booking.confirmed', result: 'poison' });
    expect(incSpy).toHaveBeenCalledTimes(2);
  });

  it('INVARIANTE: EventResult (transporte) ∩ BusinessEventResult (negocio) = ∅ — derivado, robusto a futuros valores', () => {
    // El invariante completo, no una muestra: el `result` de domain_events_total es transporte (base) O
    // negocio (handlers), nunca ambiguo. Comparamos los conjuntos COMPLETOS derivados de Object.values —
    // si alguien agrega un valor que colisiona (ej. un BusinessEventResult que reusa 'consumed'), el MISMO
    // mensaje quedaría contado con dos significados de `result` → este test lo atrapa sin tener que listarlos.
    const transport = new Set<string>(Object.values(EventResult));
    const overlap = Object.values(BusinessEventResult).filter((v) => transport.has(v));
    expect(overlap).toEqual([]);
  });
});

describe('KafkaEventProducer · métrica domain_events_total (publish)', () => {
  beforeEach(() => {
    incSpy.mockClear();
    producerMock.send.mockClear();
    producerMock.send.mockResolvedValue(undefined);
  });

  it('publish OK → inc { event, result:"published" }', async () => {
    const kafka = createKafka({ clientId: 'test', brokers: ['localhost:9092'] });
    const producer = new KafkaEventProducer(kafka);

    const envelope = createEnvelope({
      eventType: 'booking.confirmed',
      producer: 'booking-service',
      payload: {
        bookingId: 'b1',
        publishedTripId: 'pt1',
        passengerId: 'p1',
        asientos: 1,
        precioAcordado: 4500,
        paymentId: 'pay1',
        estado: 'CONFIRMADO' as const,
      },
    });

    await producer.publish(envelope, 'b1');

    expect(producerMock.send).toHaveBeenCalledTimes(1);
    expect(incSpy).toHaveBeenCalledTimes(1);
    expect(incSpy).toHaveBeenCalledWith({ event: 'booking.confirmed', result: 'published' });
  });
});
