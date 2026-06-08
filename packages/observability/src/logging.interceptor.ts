/**
 * LoggingInterceptor (FOUNDATION §5): loguea cada request HTTP con método, ruta, status, latencia y traceId.
 * También mide la métrica http_request_duration_seconds.
 */
import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { type Observable, tap } from 'rxjs';
import { httpRequestDuration } from './metrics.js';
import { createLogger, type Logger } from './logger.js';

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
        next: () => this.record(http.getResponse<ResLike>().statusCode ?? 200, method, route, start),
        error: () => this.record(500, method, route, start),
      }),
    );
  }

  private record(status: number, method: string, route: string, start: bigint): void {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequestDuration.observe({ method, route, status: String(status) }, seconds);
    const traceId = trace.getActiveSpan()?.spanContext().traceId;
    this.logger.info({ method, route, status, durationMs: Math.round(seconds * 1000), traceId }, 'request');
  }
}
