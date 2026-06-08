/**
 * Filtro global del BFF. Mapea al modelo de error público uniforme
 * `{ error: { code, message, details?, traceId } }`:
 *  - DownstreamError (@veo/rpc) → conserva status/code/message del servicio aguas abajo.
 *  - DomainError (@veo/utils)   → status/code propios del dominio.
 *  - HttpException (Nest)       → status nativo (validación de DTOs, etc.).
 *  - Resto                       → 500 INTERNAL.
 * Loguea con traceId e incrementa la métrica errors_total.
 */
import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { isDomainError } from '@veo/utils';
import { DownstreamError } from '@veo/rpc';
import { createLogger, errorsTotal, type Logger } from '@veo/observability';

interface HttpResponseLike {
  status(code: number): { json(body: unknown): void };
}
interface HttpRequestLike {
  method?: string;
  url?: string;
}

@Catch()
export class PublicExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger = createLogger('driver-bff')) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<HttpResponseLike>();
    const req = ctx.getRequest<HttpRequestLike>();
    const traceId = trace.getActiveSpan()?.spanContext().traceId;

    let status = 500;
    let code = 'INTERNAL';
    let message = 'Error interno';
    let details: Record<string, unknown> | undefined;

    if (exception instanceof DownstreamError) {
      status = exception.status;
      code = exception.code;
      message = exception.message;
      details = isRecord(exception.details) ? exception.details : undefined;
    } else if (isDomainError(exception)) {
      status = exception.httpStatus;
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = `HTTP_${status}`;
      message = exception.message;
      const response = exception.getResponse();
      if (isRecord(response)) details = response;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
