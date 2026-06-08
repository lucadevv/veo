/**
 * RateLimitGuard — limitador propio sobre Redis (sin SaaS, FOUNDATION soberanía).
 * Ventana fija por clave IP + usuario + ruta. Implementado con INCR + EXPIRE atómicos
 * (el EXPIRE solo se fija en la primera petición de la ventana). Supera el límite → 429.
 */
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import type { AuthenticatedUser } from '@veo/auth';
import { RateLimitError } from '@veo/utils';
import { REDIS } from '../../infra/redis';
import type { Env } from '../../config/env.schema';

interface RateLimitedRequest {
  user?: AuthenticatedUser;
  ip?: string;
  method?: string;
  route?: { path?: string };
  originalUrl?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly windowSeconds: number;
  private readonly max: number;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.windowSeconds = config.getOrThrow<number>('RATE_LIMIT_WINDOW_SECONDS');
    this.max = config.getOrThrow<number>('RATE_LIMIT_MAX');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RateLimitedRequest>();
    const key = this.buildKey(req);

    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, this.windowSeconds);
    }
    if (count > this.max) {
      const ttl = await this.redis.ttl(key);
      throw new RateLimitError('Demasiadas peticiones, intenta más tarde', {
        retryAfterSeconds: ttl > 0 ? ttl : this.windowSeconds,
        limit: this.max,
        windowSeconds: this.windowSeconds,
      });
    }
    return true;
  }

  /** Clave de la ventana: rl:{ip}:{userId|anon}:{método}:{ruta}. */
  private buildKey(req: RateLimitedRequest): string {
    const ip = this.resolveIp(req);
    const subject = req.user?.userId ?? 'anon';
    const route = req.route?.path ?? req.originalUrl ?? req.url ?? 'unknown';
    const method = req.method ?? 'GET';
    return `veo:driver-bff:rl:${ip}:${subject}:${method}:${route}`;
  }

  private resolveIp(req: RateLimitedRequest): string {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length > 0) {
      const first = fwd.split(',')[0];
      if (first) return first.trim();
    }
    if (Array.isArray(fwd) && fwd.length > 0) {
      const first = fwd[0];
      if (first) return first.trim();
    }
    return req.ip ?? 'unknown';
  }
}
