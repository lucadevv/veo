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
  route?: { path?: string };
  user?: AuthenticatedUser;
  socket?: { remoteAddress?: string };
  body?: Record<string, unknown>;
  headers?: Record<string, string | string[] | undefined>;
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

  /**
   * IP real del cliente. Detrás de cloudflared/ALB, `req.ip` y `x-forwarded-for` resuelven al túnel
   * (todos los clientes comparten la IP del proxy → un único cubo global, rate-limit inútil). Por eso
   * `cf-connecting-ip` (la IP real que pone Cloudflare, no spoofeable si el tráfico entra por
   * Cloudflare) tiene PRECEDENCIA. Si no está, caemos a `x-forwarded-for` (primer hop) y por último a
   * `req.ip`/socket. Lógica consistente con admin-bff y driver-bff.
   *
   * NOTA (follow-up C2): leer `x-forwarded-for` CRUDO es spoofeable. El fix de plataforma definitivo es
   * `app.set('trust proxy', <hops conocidos>)` en los 3 main.ts para que `req.ip` sea un-spoofeable.
   */
  private clientIp(req: RequestLike): string {
    const headers = req.headers;
    if (headers) {
      const cf = this.firstHeader(headers['cf-connecting-ip']);
      if (cf) return cf;
      const fwd = headers['x-forwarded-for'];
      if (typeof fwd === 'string' && fwd.length > 0) return (fwd.split(',')[0] ?? fwd).trim();
      if (Array.isArray(fwd) && fwd.length > 0) return fwd[0]?.trim() ?? 'unknown';
    }
    return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  }

  /** Primer valor no vacío de un header string | string[]; undefined si no aplica. */
  private firstHeader(value: string | string[] | undefined): string | undefined {
    if (typeof value === 'string' && value.length > 0) return value.trim();
    if (Array.isArray(value) && value.length > 0) return value[0]?.trim() || undefined;
    return undefined;
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
