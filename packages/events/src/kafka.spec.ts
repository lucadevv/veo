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

vi.mock('kafkajs', () => ({
  Kafka: class {
    consumer() {
      return consumerMock;
    }
    producer() {
      return {};
    }
  },
  logLevel: { WARN: 4 },
}));

// Import DESPUÉS del mock (vi.mock se hoistea, pero el import dinámico deja claro el orden).
const { KafkaEventConsumer, createKafka } = await import('./kafka.js');
const { createEnvelope } = await import('./envelope.js');

function makeConsumer() {
  const kafka = createKafka({ clientId: 'test', brokers: ['localhost:9092'] });
  return new KafkaEventConsumer(kafka, 'test-group');
}

describe('KafkaEventConsumer · eachMessage poison-safe parse', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    captured = undefined;
    consumerMock.run.mockClear();
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
