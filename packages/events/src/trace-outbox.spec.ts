/**
 * Tests de la PROPAGACIÓN DE TRAZA a través del OUTBOX (causa raíz: el relay publica desacoplado del
 * request → la traza se partía). Verifican las piezas deterministas, sin colector OTel real:
 *
 *  (a) createEnvelope CAPTURA el traceparent del span ACTIVO en el enqueue, y NO lo setea sin span.
 *  (b) el traceparent PERSISTE en el envelope serializado (lo que el outbox guarda como JSON).
 *  (c) producer.publish ENVUELVE el `send` en el contexto restaurado cuando el envelope trae traceparent
 *      (el span activo dentro del send lleva el traceId del request → linkeado al request, no al tick).
 *  (d) un envelope VIEJO sin traceparent publica NORMAL (send sin contexto restaurado) — backward-compat.
 *
 * NO se mockea @veo/observability: usamos las funciones REALES de propagación (es lo que se prueba) sobre
 * un BasicTracerProvider real. kafkajs SÍ se mockea para capturar el `send` y observar el contexto activo.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { context, trace, propagation, type Span } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

// Capturamos el traceId ACTIVO en el momento del `send` para probar el linkage del publish.
let traceIdInsideSend: string | undefined;
const producerMock = {
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  send: vi.fn(async () => {
    traceIdInsideSend = trace.getActiveSpan()?.spanContext().traceId;
  }),
};

vi.mock('kafkajs', () => ({
  Kafka: class {
    producer() {
      return producerMock;
    }
    consumer() {
      return producerMock;
    }
  },
  logLevel: { WARN: 4 },
}));

// Métrica real evita registrarse en el Registry compartido entre tests → la stubeamos a no-op,
// PERO dejamos runWithExtractedTraceparent REAL (es justo lo que probamos). Por eso usamos
// importActual y solo reemplazamos el counter.
vi.mock('@veo/observability', async () => {
  const actual = await vi.importActual<typeof import('@veo/observability')>('@veo/observability');
  return {
    ...actual,
    domainEventsTotal: { inc: vi.fn() },
  };
});

const { KafkaEventProducer, createKafka } = await import('./kafka.js');
const { createEnvelope } = await import('./envelope.js');

let provider: BasicTracerProvider;

beforeAll((): void => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  // Propagador W3C global para que inject/extract sean reales (es lo que prueba el linkage).
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(new InMemorySpanExporter()));
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  context.disable();
  trace.disable();
});

function withActiveSpan<R>(fn: (span: Span) => R): R {
  const span = trace.getTracer('test').startSpan('request');
  const ctx = trace.setSpan(context.active(), span);
  try {
    return context.with(ctx, () => fn(span));
  } finally {
    span.end();
  }
}

const payload = {
  bookingId: 'b1',
  publishedTripId: 'pt1',
  passengerId: 'p1',
  asientos: 1,
  precioAcordado: 4500,
  paymentId: 'pay1',
  estado: 'CONFIRMADO' as const,
};

describe('createEnvelope · captura del traceparent en el enqueue (request)', () => {
  it('(a) con span ACTIVO popula envelope.traceparent con el traceId del request', () => {
    withActiveSpan((span) => {
      const env = createEnvelope({
        eventType: 'booking.confirmed',
        producer: 'booking-service',
        payload,
      });
      expect(env.traceparent).toBeDefined();
      expect(env.traceparent).toContain(span.spanContext().traceId);
    });
  });

  it('(a) SIN span activo NO setea traceparent (degrada como hoy)', () => {
    const env = createEnvelope({
      eventType: 'booking.confirmed',
      producer: 'booking-service',
      payload,
    });
    expect(env.traceparent).toBeUndefined();
  });

  it('(b) el traceparent PERSISTE en el envelope serializado a JSON (lo que el outbox guarda)', () => {
    withActiveSpan(() => {
      const env = createEnvelope({
        eventType: 'booking.confirmed',
        producer: 'booking-service',
        payload,
      });
      const roundtrip = JSON.parse(JSON.stringify(env)) as { traceparent?: string };
      expect(roundtrip.traceparent).toBe(env.traceparent);
    });
  });
});

describe('producer.publish · restauración del contexto en el publish (relay)', () => {
  beforeAll(() => {
    producerMock.send.mockClear();
  });

  it('(c) envelope CON traceparent: el send corre con el span del REQUEST activo (linkeado al request, no al tick)', async () => {
    // Capturamos el envelope DENTRO del request, luego publicamos FUERA (como el relay: contexto del tick).
    const env = withActiveSpan(() =>
      createEnvelope({ eventType: 'booking.confirmed', producer: 'booking-service', payload }),
    );
    const originalTraceId = env.traceparent!.split('-')[1];

    traceIdInsideSend = undefined;
    const producer = new KafkaEventProducer(createKafka({ clientId: 't', brokers: ['x:9092'] }));
    // Publicamos en el contexto RAÍZ (sin span): simula el tick del relay, desacoplado del request.
    await producer.publish(env, 'b1');

    expect(producerMock.send).toHaveBeenCalledTimes(1);
    // El send corrió con el contexto del request restaurado → el publish queda LINKEADO al request.
    expect(traceIdInsideSend).toBe(originalTraceId);
  });

  it('(d) envelope VIEJO sin traceparent: publica NORMAL (send sin contexto restaurado) — backward-compat', async () => {
    const env = createEnvelope({
      eventType: 'booking.confirmed',
      producer: 'booking-service',
      payload,
    });
    expect(env.traceparent).toBeUndefined();

    producerMock.send.mockClear();
    traceIdInsideSend = 'SENTINEL';
    const producer = new KafkaEventProducer(createKafka({ clientId: 't', brokers: ['x:9092'] }));
    await producer.publish(env, 'b1');

    expect(producerMock.send).toHaveBeenCalledTimes(1);
    // Sin traceparent → no se restaura ningún span → no hay span activo en el send (publish histórico).
    expect(traceIdInsideSend).toBeUndefined();
  });
});
