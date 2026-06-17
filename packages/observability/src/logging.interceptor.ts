/**
 * LoggingInterceptor (FOUNDATION §5): loguea cada request HTTP con método, ruta, status, latencia y traceId.
 * También mide la métrica http_request_duration_seconds.
 */
import {
  HttpException,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { type Observable, tap } from 'rxjs';
import { httpRequestDuration } from './metrics.js';
import { createLogger, type Logger } from './logger.js';

/**
 * Status HTTP REAL de la excepción, en el punto del interceptor (ANTES de que corra el ExceptionFilter,
 * así que `response.statusCode` todavía es el default). Lo derivamos del propio error — el MISMO criterio
 * que `AllExceptionsFilter.mapBase`: `HttpException.getStatus()` · `DomainError.httpStatus` · `status`/
 * `statusCode` de los http-errors (body-parser). Fallback 500 sólo para errores SIN status (los 500 reales).
 * Antes el interceptor hardcodeaba 500 en TODA excepción → los 4xx (400/429) se logueaban como 500.
 */
export function statusFromError(err: unknown): number {
  if (err instanceof HttpException) return err.getStatus();
  if (err !== null && typeof err === 'object') {
    const e = err as { status?: unknown; statusCode?: unknown; httpStatus?: unknown };
    const raw = [e.status, e.statusCode, e.httpStatus].find((v) => typeof v === 'number');
    if (typeof raw === 'number' && raw >= 400 && raw <= 599) return raw;
  }
  return 500;
}

interface ReqLike {
  method?: string;
  url?: string;
  route?: { path?: string };
}
interface ResLike {
  statusCode?: number;
}

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger: Logger;
  constructor(service = 'http') {
    this.logger = createLogger(service);
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<ReqLike>();
    const start = process.hrtime.bigint();
    const method = req.method ?? 'GET';
    const route = req.route?.path ?? req.url ?? 'unknown';

    return next.handle().pipe(
      tap({
        next: () =>
          this.record(http.getResponse<ResLike>().statusCode ?? 200, method, route, start),
        error: (err) => this.record(statusFromError(err), method, route, start),
      }),
    );
  }

  private record(status: number, method: string, route: string, start: bigint): void {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequestDuration.observe({ method, route, status: String(status) }, seconds);
    const traceId = trace.getActiveSpan()?.spanContext().traceId;
    this.logger.info(
      { method, route, status, durationMs: Math.round(seconds * 1000), traceId },
      'request',
    );
  }
}
