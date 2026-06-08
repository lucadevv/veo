/**
 * httpClient interno del adapter ProntoPaga.
 *
 * POR QUÉ EXISTE (payments/prontopaga-cloudflare-fix): ProntoPaga está detrás de Cloudflare, que
 * desafía/bloquea (403 + challenge HTML) tráfico que considera automatizado. En una sesión previa se
 * observó un split binario REAL desde esta misma máquina: un script standalone con el paquete `undici`
 * → 200 OK; el servicio in-process (que usa el `fetch` GLOBAL de Node) → 403. La única variable que
 * diferenciaba ambos era que el `fetch` global queda ENVUELTO por `@opentelemetry/instrumentation-undici`
 * (aunque suprimimos la propagación de contexto a hosts ProntoPaga, la instrumentación sigue parcheando
 * el dispatcher global). Para eliminar esa variable de raíz, el gateway deja de usar el `fetch` global y
 * habla por `undici.request` con un Agent DEDICADO:
 *   - HTTP/1.1 sin pipelining (huella de conexión estable y simple),
 *   - headers explícitos en orden estable (UA identificable, sin disfraz de browser),
 *   - CERO instrumentación OTel inyectando headers (traceparent) ni envolviendo el dispatcher.
 *
 * Mantiene timeout configurable y devuelve un shape mínimo (status + text/json) que el gateway clasifica.
 * Es inyectable (interfaz `ProntoPagaHttpClient`) para testear a nivel de cliente sin tocar la red.
 */
import { Agent, request } from 'undici';

export interface ProntoPagaHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  /** Cuerpo ya serializado (string JSON) o undefined para GET/sin body. */
  body?: string;
  headers: Record<string, string>;
  /** Timeout total de la request en ms. */
  timeoutMs: number;
}

export interface ProntoPagaHttpResponse {
  status: number;
  text(): Promise<string>;
}

export interface ProntoPagaHttpClient {
  send(req: ProntoPagaHttpRequest): Promise<ProntoPagaHttpResponse>;
}

/**
 * Implementación real sobre `undici.request` con un Agent dedicado (NO el dispatcher global de Node,
 * que está instrumentado por OTel). HTTP/1.1 sin pipelining. El Agent se crea una vez por instancia y
 * reusa conexiones keep-alive; `close()` lo libera (útil en shutdown/tests).
 */
export class UndiciProntoPagaHttpClient implements ProntoPagaHttpClient {
  private readonly agent: Agent;

  constructor() {
    this.agent = new Agent({
      // HTTP/1.1, una request por conexión a la vez (sin multiplexar) → huella de conexión simple
      // y predecible, distinta del dispatcher global parcheado por OTel.
      pipelining: 1,
      keepAliveTimeout: 10_000,
      keepAliveMaxTimeout: 30_000,
      connect: { timeout: 10_000 },
    });
  }

  async send(req: ProntoPagaHttpRequest): Promise<ProntoPagaHttpResponse> {
    const res = await request(req.url, {
      method: req.method,
      dispatcher: this.agent,
      headers: req.headers,
      body: req.body,
      // Timeout de headers + body de respuesta. El controller del gateway no hace falta: undici aborta solo.
      headersTimeout: req.timeoutMs,
      bodyTimeout: req.timeoutMs,
    });
    return {
      status: res.statusCode,
      text: () => res.body.text(),
    };
  }

  /** Libera el Agent y sus conexiones keep-alive. */
  async close(): Promise<void> {
    await this.agent.close();
  }
}
