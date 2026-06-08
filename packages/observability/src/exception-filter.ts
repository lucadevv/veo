/**
 * AllExceptionsFilter (FOUNDATION §3/§5). Mapea DomainError → HTTP, loguea con traceId,
 * incrementa errors_total. Respuesta uniforme: { error: { code, message, details?, traceId } }.
 */
import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { isDomainError } from '@veo/utils';
import { errorsTotal } from './metrics.js';
import { createLogger, type Logger } from './logger.js';

interface HttpResponseLike {
  status(code: number): { json(body: unknown): void };
}
interface HttpRequestLike {
  method?: string;
  url?: string;
}

/**
 * Errores estilo `http-errors` (los que lanza body-parser/express: PayloadTooLargeError 413,
 * entity.parse.failed 400, etc.). NO son HttpException de Nest pero traen un `status`/`statusCode`
 * numérico y `expose` (si el mensaje es seguro de mostrar). Sin este narrowing caerían a 500.
 */
function asHttpErrorStatus(exception: unknown): number | undefined {
  if (exception === null || typeof exception !== 'object') return undefined;
  const e = exception as { status?: unknown; statusCode?: unknown };
  const raw = typeof e.status === 'number' ? e.status : e.statusCode;
  return typeof raw === 'number' && raw >= 400 && raw <= 599 ? raw : undefined;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger = createLogger('exception-filter')) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<HttpResponseLike>();
    const req = ctx.getRequest<HttpRequestLike>();
    const traceId = trace.getActiveSpan()?.spanContext().traceId;

    let status = 500;
    let code = 'INTERNAL';
    let message = 'Error interno';
    let details: Record<string, unknown> | undefined;

    if (isDomainError(exception)) {
      status = exception.httpStatus;
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = `HTTP_${status}`;
      message = exception.message;
    } else if (asHttpErrorStatus(exception) !== undefined) {
      // body-parser / http-errors (p.ej. PayloadTooLargeError → 413): respetar su status,
      // no degradarlo a 500. El mensaje de estos errores es genérico y seguro de exponer.
      // La rama ya garantizó `!== undefined`; el `?? 500` es defensivo (TS no arrastra el narrowing
      // de la llamada en la condición) y evita el non-null assertion.
      status = asHttpErrorStatus(exception) ?? 500;
      code = `HTTP_${status}`;
      message = exception instanceof Error ? exception.message : 'Solicitud inválida';
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    errorsTotal.inc({ code, status: String(status) });

    const logPayload = { code, status, traceId, method: req.method, url: req.url };
    if (status >= 500) {
      this.logger.error({ ...logPayload, err: exception }, message);
    } else {
      this.logger.warn(logPayload, message);
    }

    res.status(status).json({ error: { code, message, details, traceId } });
  }
}
