/**
 * Bootstrap de OpenTelemetry (FOUNDATION §5). Llamar ANTES de crear la app NestJS.
 * Auto-instrumenta http/express/kafkajs/pg y exporta trazas vía OTLP (Jaeger/colector).
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

let sdk: NodeSDK | undefined;

export interface OtelOptions {
  serviceName: string;
  serviceVersion?: string;
  otlpEndpoint?: string;
}

/** Inicializa OTel. Idempotente: segunda llamada no hace nada. Devuelve un shutdown. */
export function bootstrapOtel(opts: OtelOptions): () => Promise<void> {
  if (sdk) return shutdownOtel;
  const endpoint = opts.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: opts.serviceName,
      [ATTR_SERVICE_VERSION]: opts.serviceVersion ?? '0.1.0',
    }),
    traceExporter: new OTLPTraceExporter(endpoint ? { url: `${endpoint}/v1/traces` } : {}),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        // El instrumentador de `undici`/fetch INYECTA `traceparent` en cada request saliente. Algunos
        // gateways externos detrás de un WAF (ProntoPaga/Cloudflare) RECHAZAN con 403 los requests con
        // `traceparent` (los marcan como tráfico automatizado). Suprimimos la propagación de contexto a
        // esos hosts (no creamos span de cliente ni inyectamos headers) — el resto sí se traza normal.
        // Configurable por OTEL_UNDICI_IGNORE_HOSTS (CSV de substrings); default cubre ProntoPaga.
        '@opentelemetry/instrumentation-undici': {
          ignoreRequestHook: (req: { origin?: string | URL }) => {
            const ignore = (process.env.OTEL_UNDICI_IGNORE_HOSTS ?? 'prontopaga.com')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            const origin =
              typeof req.origin === 'string' ? req.origin : (req.origin?.toString() ?? '');
            return ignore.some((h) => origin.includes(h));
          },
        },
      }),
    ],
  });
  sdk.start();
  return shutdownOtel;
}

export async function shutdownOtel(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = undefined;
}
