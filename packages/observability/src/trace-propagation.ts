/**
 * Propagación de TRAZA a través de un STORE (patrón OTel "context-propagation-through-store").
 *
 * EL PROBLEMA: el outbox desacopla el publish del request. El evento se escribe al outbox en la tx del
 * REQUEST, pero un RELAY asíncrono lo publica DESPUÉS — cuando el contexto OTel del request ya murió. La
 * auto-instrumentación de kafkajs entonces linkea el span del publish al TICK del relay, no al request, y
 * la cadena request → evento → consumer queda PARTIDA.
 *
 * EL FIX (W3C Trace Context estándar):
 *  - En el ENQUEUE (contexto del request): `captureTraceparent()` serializa el contexto activo a un string
 *    `traceparent` W3C (`00-{traceId}-{spanId}-{flags}`) vía `propagation.inject`. Se persiste en el envelope.
 *  - En el PUBLISH (contexto desacoplado del relay): `runWithExtractedTraceparent(traceparent, fn)` restaura
 *    ese traceparent como contexto activo vía `propagation.extract` + `context.with`, de modo que la
 *    auto-instrumentación de kafkajs cree el span del publish como HIJO del request original e inyecte el
 *    `traceparent` correcto en los headers Kafka → el consumer continúa la traza ORIGINAL.
 *
 * DEGRADACIÓN HONESTA: sin span activo / sin OTel registrado, `captureTraceparent()` devuelve `undefined`
 * (no setea nada) y `runWithExtractedTraceparent(undefined, fn)` ejecuta `fn` tal cual (como hoy). Nunca
 * crashea: la API de `@opentelemetry/api` está siempre presente como dependencia y degrada a no-op si no hay
 * SDK; los try/catch defensivos cubren cualquier propagador que lance.
 *
 * Cero strings mágicos de negocio: 'traceparent'/'tracestate' son nombres de header W3C ESTÁNDAR.
 */
import {
  context,
  propagation,
  trace,
  ROOT_CONTEXT,
  type Context,
  type TextMapGetter,
  type TextMapSetter,
} from '@opentelemetry/api';

/** Claves de header W3C Trace Context (estándar, no strings mágicos de negocio). */
const W3C_TRACEPARENT = 'traceparent';
const W3C_TRACESTATE = 'tracestate';

/** Carrier mínimo W3C: lo que `propagation.inject/extract` lee/escribe. `tracestate` es opcional. */
export interface TraceCarrier {
  traceparent?: string;
  tracestate?: string;
}

/** Setter: escribe sobre el carrier por asignación directa (las claves vienen del propagador W3C). */
const carrierSetter: TextMapSetter<TraceCarrier> = {
  set(carrier, key, value) {
    (carrier as Record<string, string>)[key] = value;
  },
};

/** Getter: lee las claves del carrier. Solo expone las presentes (W3C las accede por nombre). */
const carrierGetter: TextMapGetter<TraceCarrier> = {
  keys(carrier) {
    return Object.keys(carrier);
  },
  get(carrier, key) {
    return (carrier as Record<string, string | undefined>)[key];
  },
};

/**
 * Captura el `traceparent` W3C del contexto OTel ACTIVO (el del request, en el enqueue).
 * Devuelve `undefined` si NO hay span activo (degrada como hoy) o si el propagador no inyecta nada.
 * Inocuo sin OTel: la API degrada a no-op y el try/catch cubre cualquier propagador que lance.
 */
export function captureTraceparent(): string | undefined {
  try {
    // Sin span activo → nada que propagar (NO se setea el campo): degradación honesta.
    if (!trace.getActiveSpan()) return undefined;
    const carrier: TraceCarrier = {};
    propagation.inject(context.active(), carrier, carrierSetter);
    return carrier.traceparent;
  } catch {
    // Cualquier fallo del propagador NO debe romper el enqueue del evento (negocio > traza).
    return undefined;
  }
}

/**
 * Restaura el `traceparent` capturado como contexto activo y ejecuta `fn` dentro de él. Así la
 * auto-instrumentación de kafkajs crea el span del publish como HIJO del request original.
 *
 * Sin `traceparent` (envelope viejo o request sin span) ejecuta `fn` tal cual — backward-compat total.
 * Si el extract/with fallara, cae al camino normal: la publicación NUNCA se bloquea por la traza.
 */
export function runWithExtractedTraceparent<R>(
  traceparent: string | undefined,
  fn: () => R,
): R {
  if (!traceparent) return fn(); // backward-compat: envelope sin traceparent publica normal.
  let parentCtx: Context;
  try {
    const carrier: TraceCarrier = { [W3C_TRACEPARENT]: traceparent } as TraceCarrier;
    parentCtx = propagation.extract(ROOT_CONTEXT, carrier, carrierGetter);
  } catch {
    return fn(); // extract falló (traceparent corrupto / sin propagador) → publish normal.
  }
  return context.with(parentCtx, fn);
}

/** Re-export de las claves W3C por si un caller necesita armar el carrier a mano (tests, debug). */
export const W3C_TRACE_HEADERS = { traceparent: W3C_TRACEPARENT, tracestate: W3C_TRACESTATE } as const;
