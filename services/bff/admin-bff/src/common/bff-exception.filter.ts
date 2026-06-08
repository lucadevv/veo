/**
 * BffExceptionsFilter — mapea los errores del downstream (DownstreamError de @veo/rpc) al modelo de
 * error público del BFF, preservando el status y el código del servicio de origen. Se reusa el
 * AllExceptionsFilter de @veo/observability (formato uniforme + traceId + métricas) envolviendo el
 * DownstreamError en un DomainError equivalente; el resto de excepciones se delega tal cual.
 */
import { Catch, type ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter } from '@veo/observability';
import { DomainError } from '@veo/utils';
import { DownstreamError } from '@veo/rpc';

/** DomainError que conserva el código/status/detalle reportados por el servicio downstream. */
class MappedDownstreamError extends DomainError {
  readonly code: string;
  readonly httpStatus: number;
  constructor(d: DownstreamError) {
    super(d.message, isRecord(d.details) ? d.details : undefined);
    this.code = d.code;
    this.httpStatus = d.status;
  }
}

@Catch()
export class BffExceptionsFilter extends AllExceptionsFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    if (exception instanceof DownstreamError) {
      super.catch(new MappedDownstreamError(exception), host);
      return;
    }
    super.catch(exception, host);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
