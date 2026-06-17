/**
 * AllExceptionsFilter (FOUNDATION §3/§5). Mapea DomainError → HTTP, loguea con traceId,
 * incrementa errors_total. Respuesta uniforme: { error: { code, message, details?, traceId } }.
 *
 * FUENTE ÚNICA del contrato error→HTTP: los servicios lo usan tal cual; los BFFs usan
 * BffExceptionsFilter (@veo/rpc) que EXTIENDE este filtro vía el hook `mapException` para
 * agregar el mapeo de DownstreamError. Lo que difiere a propósito entre superficies
 * (¿exponer el message interno en un 500? ¿incluir el body de HttpException como details?)
 * son PARÁMETROS explícitos (ExceptionFilterOptions), no copias del filtro.
 */
import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { isDomainError, isRecord } from '@veo/utils';
import { errorsTotal } from './metrics.js';
import { createLogger, type Logger } from './logger.js';

/** Código del fallback 500 cuando la excepción no tiene mapeo propio. */
export const INTERNAL_ERROR_CODE = 'INTERNAL';
/** Mensaje del fallback 500 (también usado cuando NO se expone el message interno). */
export const INTERNAL_ERROR_MESSAGE = 'Error interno';
/** Mensaje genérico para errores http-errors sin message seguro. */
export const INVALID_REQUEST_MESSAGE = 'Solicitud inválida';
/** Código sintético para excepciones HTTP sin código de dominio (HttpException, http-errors). */
export function httpStatusCode(status: number): string {
  return `HTTP_${status}`;
}

/** Resultado del mapeo excepción → modelo de error público (sin traceId; lo agrega el filtro). */
export interface MappedHttpError {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Lo que DE VERDAD difiere entre superficies (BFF público vs admin vs microservicio interno). */
export interface ExceptionFilterOptions {
  /**
   * Exponer `error.message` de un Error genérico en el 500 (default true: servicios internos y
   * superficies admin/driver). Las superficies públicas lo apagan → 'Error interno'.
   */
  exposeInternalErrorMessage?: boolean;
  /**
   * Incluir el body de `HttpException.getResponse()` como `details` cuando es un objeto
   * (default false). driver-bff lo enciende: su app lee los mensajes de validación de DTOs.
   */
  exposeHttpExceptionDetails?: boolean;
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
  constructor(
    private readonly logger: Logger = createLogger('exception-filter'),
    private readonly options: ExceptionFilterOptions = {},
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<HttpResponseLike>();
    const req = ctx.getRequest<HttpRequestLike>();
    const traceId = trace.getActiveSpan()?.spanContext().traceId;

    const { status, code, message, details } =
      this.mapException(exception) ?? this.mapBase(exception);

    errorsTotal.inc({ code, status: String(status) });

    const logPayload = { code, status, traceId, method: req.method, url: req.url };
    if (status >= 500) {
      this.logger.error({ ...logPayload, err: exception }, message);
    } else {
      this.logger.warn(logPayload, message);
    }

    res.status(status).json({ error: { code, message, details, traceId } });
  }

  /**
   * Hook de extensión: mapeos que van ANTES del base (p.ej. DownstreamError en los BFFs).
   * Devolver `undefined` delega en el mapeo base.
   */
  protected mapException(_exception: unknown): MappedHttpError | undefined {
    return undefined;
  }

  /** Mapeo base: DomainError → HttpException → http-errors → Error → fallback 500. */
  private mapBase(exception: unknown): MappedHttpError {
    if (isDomainError(exception)) {
      return {
        status: exception.httpStatus,
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      return {
        status,
        code: httpStatusCode(status),
        message: exception.message,
        details:
          this.options.exposeHttpExceptionDetails && isRecord(response) ? response : undefined,
      };
    }
    // body-parser / http-errors (p.ej. PayloadTooLargeError → 413): respetar su status,
    // no degradarlo a 500. El mensaje de estos errores es genérico y seguro de exponer.
    const httpErrStatus = asHttpErrorStatus(exception);
    if (httpErrStatus !== undefined) {
      return {
        status: httpErrStatus,
        code: httpStatusCode(httpErrStatus),
        message: exception instanceof Error ? exception.message : INVALID_REQUEST_MESSAGE,
      };
    }
    if (exception instanceof Error && this.options.exposeInternalErrorMessage !== false) {
      return { status: 500, code: INTERNAL_ERROR_CODE, message: exception.message };
    }
    return { status: 500, code: INTERNAL_ERROR_CODE, message: INTERNAL_ERROR_MESSAGE };
  }
}

interface HttpResponseLike {
  status(code: number): { json(body: unknown): void };
}
interface HttpRequestLike {
  method?: string;
  url?: string;
}
