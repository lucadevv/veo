/**
 * RateLimitGuard — limitación personalizada con Redis (ventana deslizante por IP+usuario).
 * Decisión FOUNDATION §14: rate-limit en los BFFs (Redis). El admin-bff no recibe POST /panic crudo,
 * así que aquí no hay excepción de pánico; sí se exceptúan health/metrics.
 * Algoritmo: sorted set por clave; se purgan entradas fuera de ventana y se cuenta el resto.
 */
import {
  Injectable,
  Inject,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type Redis from 'ioredis';
import { RateLimitError } from '@veo/utils';
import type { AuthenticatedUser } from '@veo/auth';
import { REDIS } from '../infra/tokens';
import type { Env } from '../config/env.schema';
import { SKIP_RATE_LIMIT_KEY } from './skip-rate-limit.decorator';

interface RequestLike {
  ip?: string;
  path?: string;
  url?: string;
  user?: AuthenticatedUser;
  headers: Record<string, string | string[] | undefined>;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly windowMs: number;
  private readonly max: number;

  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.windowMs = config.get('RATE_LIMIT_WINDOW_MS', { infer: true });
    this.max = config.get('RATE_LIMIT_MAX', { infer: true });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const req = context.switchToHttp().getRequest<RequestLike>();
    const path = req.path ?? req.url ?? '';
    // Health y métricas no se limitan (sondas de orquestación / scraping de Prometheus).
    if (path.startsWith('/health') || path.startsWith('/metrics')) return true;

    const ip = this.clientIp(req);
    const subject = req.user?.userId ?? 'anon';
    const key = `bff:admin:rl:${ip}:${subject}`;
    const now = Date.now();
    const windowStart = now - this.windowMs;

    const results = await this.redis
      .multi()
      .zremrangebyscore(key, 0, windowStart)
      .zadd(key, now, `${now}-${Math.random().toString(36).slice(2)}`)
      .zcard(key)
      .pexpire(key, this.windowMs)
      .exec();

    // results[2] = [err, count] de ZCARD.
    const countEntry = results?.[2];
    const count = Array.isArray(countEntry) ? Number(countEntry[1]) : 0;
    if (count > this.max) {
      throw new RateLimitError('Límite de peticiones excedido', {
        limit: this.max,
        windowMs: this.windowMs,
      });
    }
    return true;
  }

  private clientIp(req: RequestLike): string {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length > 0) return (fwd.split(',')[0] ?? fwd).trim();
    if (Array.isArray(fwd) && fwd.length > 0) return fwd[0] ?? 'unknown';
    return req.ip ?? 'unknown';
  }
}
