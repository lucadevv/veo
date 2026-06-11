/**
 * BffExceptionsFilter — ExceptionFilter CANÓNICO de los BFFs (fuente única del contrato
 * downstream→HTTP). Extiende el AllExceptionsFilter de @veo/observability (formato uniforme
 * `{ error: { code, message, details?, traceId } }` + log con traceId + métrica errors_total)
 * agregando el mapeo de DownstreamError (el error normalizado de los clientes gRPC/REST de
 * este paquete). Vive acá porque @veo/rpc es el toolkit BFF→microservicio y es dueño de
 * DownstreamError; @veo/observability no depende de @veo/rpc (sin ciclos).
 *
 * Lo que difiere a propósito entre BFFs son PARÁMETROS explícitos, no copias del filtro:
 *  - `maskDownstream5xx` (public-bff): los 5xx aguas abajo NO filtran internals; se aplastan
 *    a 502 UPSTREAM_UNAVAILABLE (reintentable). Los <500 (p.ej. 422 GATEWAY_CAPABILITY_
 *    UNAVAILABLE) se propagan LIMPIOS (code+status+details intactos).
 *  - `exposeHttpExceptionDetails` / `exposeInternalErrorMessage`: ver ExceptionFilterOptions.
 */
import { Catch } from '@nestjs/common';
import {
  AllExceptionsFilter,
  type ExceptionFilterOptions,
  type Logger,
  type MappedHttpError,
} from '@veo/observability';
import { isRecord } from '@veo/utils';
import { DownstreamError } from './error.js';

/** Código público cuando un downstream 5xx se aplasta (no exponer internals; reintentable). */
export const UPSTREAM_UNAVAILABLE_CODE = 'UPSTREAM_UNAVAILABLE';
/** Status público del downstream 5xx aplastado. */
export const UPSTREAM_UNAVAILABLE_STATUS = 502;
/** Mensaje público del downstream 5xx aplastado. */
export const UPSTREAM_UNAVAILABLE_MESSAGE = 'Servicio temporalmente no disponible';

export interface BffExceptionFilterOptions extends ExceptionFilterOptions {
  /**
   * Aplastar los 5xx del downstream a 502 UPSTREAM_UNAVAILABLE sin exponer message/details
   * internos (superficies públicas). Default false: admin/driver conservan status/code/message
   * del servicio de origen (deliberado: más detalle para operación y para la app del conductor).
   */
  maskDownstream5xx?: boolean;
}

@Catch()
export class BffExceptionsFilter extends AllExceptionsFilter {
  private readonly maskDownstream5xx: boolean;

  constructor(logger?: Logger, options: BffExceptionFilterOptions = {}) {
    super(logger, options);
    this.maskDownstream5xx = options.maskDownstream5xx ?? false;
  }

  /** DownstreamError → modelo público; el resto delega en el mapeo base (DomainError, etc.). */
  protected override mapException(exception: unknown): MappedHttpError | undefined {
    if (!(exception instanceof DownstreamError)) return undefined;
    if (this.maskDownstream5xx && exception.status >= 500) {
      return {
        status: UPSTREAM_UNAVAILABLE_STATUS,
        code: UPSTREAM_UNAVAILABLE_CODE,
        message: UPSTREAM_UNAVAILABLE_MESSAGE,
      };
    }
    return {
      status: exception.status,
      code: exception.code,
      message: exception.message,
      details: isRecord(exception.details) ? exception.details : undefined,
    };
  }
}
