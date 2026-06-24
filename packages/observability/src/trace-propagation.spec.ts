/**
 * Tests de la propagación de TRAZA a través del store (context-propagation-through-store).
 *
 * Verifican las PIEZAS deterministas del fix (sin colector OTel real):
 *  - captureTraceparent() emite el traceparent W3C cuando hay un span ACTIVO, y `undefined` sin span.
 *  - runWithExtractedTraceparent() reconstruye el contexto y lo deja ACTIVO dentro de `fn` (el span
 *    extraído queda como activo → la auto-instrumentación de kafkajs lo usaría como padre del publish).
 *  - degradación honesta: sin traceparent ejecuta `fn` tal cual; sin OTel/sin span no crashea.
 *
 * Usamos el BasicTracerProvider real de OTel (sin exportador): registra el W3CTraceContextPropagator y un
 * context manager, suficiente para inject/extract/active reales — el linkage end-to-end con Kafka real no
 * es factible en unit test, así que verificamos que el contexto se restaura (precondición del linkage).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  context,
  trace,
  ROOT_CONTEXT,
  propagation,
  type Span,
  type Context,
} from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  captureTraceparent,
  runWithExtractedTraceparent,
} from './trace-propagation.js';

const W3C_TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

let provider: BasicTracerProvider;

beforeAll(() => {
  // SDK real mínimo: provider + context manager (AsyncLocalStorage) + propagador W3C global.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(new InMemorySpanExporter()));
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  context.disable();
  trace.disable();
  propagation.disable();
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

describe('captureTraceparent · captura en el contexto del request', () => {
  it('con span ACTIVO devuelve un traceparent W3C bien formado que contiene el traceId del span', () => {
    withActiveSpan((span) => {
      const tp = captureTraceparent();
      expect(tp).toBeDefined();
      expect(tp).toMatch(W3C_TRACEPARENT_RE);
      // El traceparent debe portar el MISMO traceId del span activo (es su contexto, no otro).
      expect(tp).toContain(span.spanContext().traceId);
      expect(tp).toContain(span.spanContext().spanId);
    });
  });

  it('SIN span activo devuelve undefined (degradación honesta: no setea nada, como hoy)', () => {
    // Ejecutamos en ROOT_CONTEXT explícito: no hay span activo.
    context.with(ROOT_CONTEXT, () => {
      expect(captureTraceparent()).toBeUndefined();
    });
  });
});

describe('runWithExtractedTraceparent · restauración en el publish (relay)', () => {
  it('restaura el traceparent: dentro de fn el contexto activo lleva el span extraído con ese traceId', () => {
    // Capturamos en un "request" y luego, FUERA de él (contexto desacoplado como el relay), restauramos.
    const captured = withActiveSpan(() => captureTraceparent());
    expect(captured).toBeDefined();

    // Afuera del request: sin restaurar NO habría span (simula el tick del relay).
    let activeInsideTraceId: string | undefined;
    context.with(ROOT_CONTEXT, () => {
      expect(trace.getActiveSpan()).toBeUndefined(); // confirma el desacople: sin contexto del request.
      runWithExtractedTraceparent(captured, () => {
        activeInsideTraceId = trace.getActiveSpan()?.spanContext().traceId;
      });
    });

    // El contexto restaurado lleva el traceId del request original → el publish quedaría LINKEADO a él.
    const originalTraceId = (captured as string).split('-')[1];
    expect(activeInsideTraceId).toBe(originalTraceId);
  });

  it('verifica el linkage via extract directo: el contexto restaurado es padre del publish', () => {
    const captured = withActiveSpan(() => captureTraceparent())!;
    // Reproduce lo que hace kafkajs en el producer: extrae del contexto activo restaurado e inyecta.
    let injected: Record<string, string> = {};
    runWithExtractedTraceparent(captured, () => {
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier);
      injected = carrier;
    });
    // El traceparent inyectado por el "producer" comparte el traceId del request original (misma traza).
    expect(injected.traceparent).toBeDefined();
    expect(injected.traceparent!.split('-')[1]).toBe(captured.split('-')[1]);
  });

  it('SIN traceparent (envelope viejo) ejecuta fn tal cual — backward-compat, sin span restaurado', () => {
    let ran = false;
    let hadSpan = true;
    context.with(ROOT_CONTEXT, () => {
      const ret = runWithExtractedTraceparent(undefined, () => {
        ran = true;
        hadSpan = trace.getActiveSpan() !== undefined;
        return 42;
      });
      expect(ret).toBe(42); // devuelve el valor de fn sin envolver.
    });
    expect(ran).toBe(true);
    expect(hadSpan).toBe(false); // no inventó un contexto: publish normal.
  });

  it('un traceparent CORRUPTO no crashea: cae al camino normal y ejecuta fn', () => {
    let ran = false;
    const ret = runWithExtractedTraceparent('no-es-w3c', () => {
      ran = true;
      return 'ok';
    });
    expect(ran).toBe(true);
    expect(ret).toBe('ok');
  });

  it('propaga el valor de retorno (incluida una promesa) de fn', async () => {
    const captured = withActiveSpan(() => captureTraceparent())!;
    const p = runWithExtractedTraceparent(captured, async () => 'async-ok');
    await expect(p).resolves.toBe('async-ok');
  });
});

describe('degradación sin OTel registrado (no crashea)', () => {
  it('captureTraceparent y runWith... funcionan aun con el SDK deshabilitado', () => {
    // Deshabilitamos temporalmente el context manager/propagador → la API degrada a no-op.
    context.disable();
    trace.disable();
    propagation.disable();
    try {
      // Sin span activo posible → undefined, sin lanzar.
      expect(captureTraceparent()).toBeUndefined();
      // runWith ejecuta fn igual (sin traceparent o con uno: nunca crashea).
      let ran = false;
      runWithExtractedTraceparent(undefined, () => {
        ran = true;
      });
      expect(ran).toBe(true);
    } finally {
      // Rehabilitamos para no contaminar otros describes (el orden de afterAll asume habilitado).
      context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
      propagation.setGlobalPropagator(new W3CTraceContextPropagator());
      trace.setGlobalTracerProvider(provider);
    }
  });
});

// Marca de uso para tipos importados solo a nivel de tipo (evita TS6133 si tsc se pone estricto).
export type _Ctx = Context;
