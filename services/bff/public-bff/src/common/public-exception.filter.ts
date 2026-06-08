/**
 * Filtro de excepciones del BFF. Modelo de error público uniforme (FOUNDATION §3):
 *   { error: { code, message, details?, traceId } }
 * Mapea DownstreamError de @veo/rpc al modelo público SIN filtrar internals (los 5xx aguas abajo
 * se devuelven como 502 genérico). DomainError y HttpException se mapean directamente.
 */
import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { isDomainError } from '@veo/utils';
import { DownstreamError } from '@veo/rpc';
import { errorsTotal, createLogger, type Logger } from '@veo/observability';

interface HttpResponseLike {
  status(code: number): { json(body: unknown): void };
}
interface HttpRequestLike {
  method?: string;
  url?: string;
}

interface MappedError {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

@Catch()
export class PublicExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger = createLogger('public-bff')) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<HttpResponseLike>();
    const req = ctx.getRequest<HttpRequestLike>();
    const traceId = trace.getActiveSpan()?.spanContext().traceId;

    const mapped = this.map(exception);
    errorsTotal.inc({ code: mapped.code, status: String(mapped.status) });

    const logPayload = {
      code: mapped.code,
      status: mapped.status,
      traceId,
      method: req.method,
      url: req.url,
    };
    if (mapped.status >= 500) {
      this.logger.error({ ...logPayload, err: exception }, mapped.message);
    } else {
      this.logger.warn(logPayload, mapped.message);
    }

    res.status(mapped.status).json({
      error: { code: mapped.code, message: mapped.message, details: mapped.details, traceId },
    });
  }

  /** Traduce cualquier excepción al modelo público, ocultando detalles internos de los 5xx. */
  private map(exception: unknown): MappedError {
    if (isDomainError(exception)) {
      return {
        status: exception.httpStatus,
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    }
    if (exception instanceof DownstreamError) {
      // Los 5xx downstream no exponen su mensaje interno; se reportan como upstream no disponible.
      if (exception.status >= 500) {
        return {
          status: 502,
          code: 'UPSTREAM_UNAVAILABLE',
          message: 'Servicio temporalmente no disponible',
        };
      }
      return {
        status: exception.status,
        code: exception.code,
        message: exception.message,
        details: isRecord(exception.details) ? exception.details : undefined,
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return { status, code: `HTTP_${status}`, message: exception.message };
    }
    // body-parser / http-errors (p.ej. PayloadTooLargeError → 413 cuando el body excede el límite):
    // no son HttpException pero traen un `status`/`statusCode` numérico. Respetarlo en vez de 500.
    const httpErrStatus = asHttpErrorStatus(exception);
    if (httpErrStatus !== undefined) {
      return {
        status: httpErrStatus,
        code: `HTTP_${httpErrStatus}`,
        message: exception instanceof Error ? exception.message : 'Solicitud inválida',
      };
    }
    return { status: 500, code: 'INTERNAL', message: 'Error interno' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Status de errores estilo http-errors (body-parser): 413, 400 de parse, etc. Sin esto caerían a 500. */
function asHttpErrorStatus(exception: unknown): number | undefined {
  if (exception === null || typeof exception !== 'object') return undefined;
  const e = exception as { status?: unknown; statusCode?: unknown };
  const raw = typeof e.status === 'number' ? e.status : e.statusCode;
  return typeof raw === 'number' && raw >= 400 && raw <= 599 ? raw : undefined;
}
