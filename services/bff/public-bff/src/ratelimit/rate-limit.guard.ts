/**
 * Guard de rate limiting (Redis) por IP + usuario + ruta, con ventanas configurables.
 * Se monta global DESPUÉS del JwtAuthGuard (para conocer al usuario). Los endpoints marcados
 * con @SkipRateLimit() — POST /panic — nunca se limitan.
 */
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { RateLimitError } from '@veo/utils';
import type { AuthenticatedUser } from '@veo/auth';
import { REDIS } from '../infra/redis';
import { RateLimiter, type RateLimitStore } from './rate-limiter';
import { SKIP_RATE_LIMIT_KEY } from './skip-rate-limit.decorator';
import { RATE_LIMIT_KEY, type RateLimitBy, type RateLimitOptions } from './rate-limit.decorator';
import type { Env } from '../config/env.schema';

interface RequestLike {
  method?: string;
  url?: string;
  ip?: string;
  ips?: string[];
  route?: { path?: string };
  user?: AuthenticatedUser;
  socket?: { remoteAddress?: string };
  body?: Record<string, unknown>;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS) store: RateLimitStore,
    config: ConfigService<Env, true>,
  ) {
    this.limiter = new RateLimiter(
      store,
      config.getOrThrow<number>('RATE_LIMIT_WINDOW_MS'),
      config.getOrThrow<number>('RATE_LIMIT_MAX'),
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Solo aplica a HTTP; los handlers de Socket.IO no se limitan por esta vía.
    if (context.getType() !== 'http') return true;

    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const req = context.switchToHttp().getRequest<RequestLike>();

    // Override por ruta (decorator @RateLimit): endurece rutas de auth sensibles a fuerza bruta.
    // Si existe, USA su límite/ventana/clave en vez de la config global (no se suman ambos contadores).
    const override = this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const id = override
      ? // Prefijo 'o' + clave compuesta por los campos pedidos: contador independiente del global.
        `o:${this.compositeKey(req, override.by)}`
      : this.identityFor(req);

    const result = await this.limiter.consume(
      id,
      override ? { max: override.max, windowMs: override.windowMs } : undefined,
    );
    if (!result.allowed) {
      throw new RateLimitError('Demasiadas solicitudes, intenta más tarde', {
        limit: result.limit,
      });
    }
    return true;
  }

  /** Clave de limitación por defecto: IP del cliente + usuario (o anónimo) + método:ruta. */
  private identityFor(req: RequestLike): string {
    const ip = this.clientIp(req);
    const userId = req.user?.userId ?? 'anon';
    const route = req.route?.path ?? req.url ?? 'unknown';
    const method = req.method ?? 'GET';
    return `${ip}:${userId}:${method}:${route}`;
  }

  /** IP del cliente (respeta el primer hop confiable de `req.ips` cuando hay trust proxy). */
  private clientIp(req: RequestLike): string {
    return req.ips?.[0] ?? req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  }

  /**
   * Clave compuesta para overrides: concatena los segmentos pedidos en `by` (default ['ip','user']).
   * `route` (método:ruta) SIEMPRE se incluye para no mezclar contadores entre endpoints distintos.
   * `phone`/`email` se toman del body (normalizados a minúsculas/trim) → limitar por IP+identificador.
   */
  private compositeKey(req: RequestLike, by: RateLimitBy[] = ['ip', 'user']): string {
    const route = `${req.method ?? 'GET'}:${req.route?.path ?? req.url ?? 'unknown'}`;
    const parts = by.map((field) => {
      switch (field) {
        case 'ip':
          return `ip=${this.clientIp(req)}`;
        case 'user':
          return `u=${req.user?.userId ?? 'anon'}`;
        case 'phone':
          return `ph=${this.bodyField(req, 'phone')}`;
        case 'email':
          return `em=${this.bodyField(req, 'email')}`;
        case 'route':
          return `r=${route}`;
        default:
          return '';
      }
    });
    // route siempre presente aunque no se haya pedido explícitamente.
    if (!by.includes('route')) parts.push(`r=${route}`);
    return parts.join(':');
  }

  /** Lee un campo string del body y lo normaliza (trim + minúsculas). 'none' si falta o no es string. */
  private bodyField(req: RequestLike, key: string): string {
    const value = req.body?.[key];
    return typeof value === 'string' ? value.trim().toLowerCase() : 'none';
  }
}
