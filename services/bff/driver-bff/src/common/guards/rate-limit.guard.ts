/**
 * RateLimitGuard — limitador propio sobre Redis (sin SaaS, FOUNDATION soberanía).
 * Ventana fija por clave IP + usuario + ruta. El INCR + EXPIRE es ATÓMICO (un solo script Lua vía
 * `consumeFixedWindow` de @veo/utils, COMPARTIDO por los 3 BFFs): imposible que una clave quede sin
 * TTL (bucket permanente) por una caída entre INCR y EXPIRE. Supera el límite → 429.
 *
 * Override POR MÉTODO (ADR-012): un endpoint de auth puede declarar `@RateLimit({...})` para un cap
 * estricto (ej. login/OTP) por encima del global. El guard lee esa metadata vía Reflector.
 */
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type Redis from 'ioredis';
import type { AuthenticatedUser } from '@veo/auth';
import { RateLimitError, consumeFixedWindow, canonicalizePeruPhone } from '@veo/utils';
import { REDIS } from '../../infra/redis';
import type { Env } from '../../config/env.schema';
import { RATE_LIMIT_KEY, type RateLimitBy, type RateLimitOptions } from './rate-limit.decorator';

interface RateLimitedRequest {
  user?: AuthenticatedUser;
  ip?: string;
  method?: string;
  route?: { path?: string };
  originalUrl?: string;
  url?: string;
  socket?: { remoteAddress?: string };
  body?: Record<string, unknown>;
}

/** Milisegundos por segundo (RATE_LIMIT_WINDOW_SECONDS del env se expresa en segundos). */
const MS_PER_SECOND = 1000;

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly windowMs: number;
  private readonly max: number;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly reflector: Reflector,
    config: ConfigService<Env, true>,
  ) {
    this.windowMs = config.getOrThrow<number>('RATE_LIMIT_WINDOW_SECONDS') * MS_PER_SECOND;
    this.max = config.getOrThrow<number>('RATE_LIMIT_MAX');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RateLimitedRequest>();

    // Override por ruta (decorator @RateLimit): endurece auth sensible a fuerza bruta POR MÉTODO.
    // Si existe, USA su(s) límite(s)/ventana(s)/clave(s) en vez de la config global (contadores
    // independientes). Puede ser UN límite o un ARREGLO: con varios se aplican TODOS (cada uno su
    // cubo) y basta que UNO exceda para bloquear (FIX A: cap fino IP+phone Y cap agregado por-IP).
    const override = this.reflector.getAllAndOverride<RateLimitOptions | RateLimitOptions[]>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );

    // SIN override → cubo global único. CON override → un cubo por cada límite declarado.
    const limits: RateLimitOptions[] = override
      ? Array.isArray(override)
        ? override
        : [override]
      : [{ max: this.max, windowMs: this.windowMs }];

    for (const limit of limits) {
      // Prefijo 'o' (override): cubo separado del global para no mezclar contadores. La clave compuesta
      // (incluye `by`) hace que cada dimensión — ['ip','phone'] vs ['ip'] — tenga su PROPIO cubo.
      const key = override
        ? `veo:driver-bff:rl:o:${this.compositeKey(req, limit.by)}`
        : this.buildKey(req);

      const result = await consumeFixedWindow(this.redis, key, limit.max, limit.windowMs);
      if (!result.allowed) {
        const retryAfterSeconds =
          Math.ceil(result.resetMs / MS_PER_SECOND) || limit.windowMs / MS_PER_SECOND;
        throw new RateLimitError('Demasiadas peticiones, intenta más tarde', {
          retryAfterSeconds,
          limit: limit.max,
          windowSeconds: limit.windowMs / MS_PER_SECOND,
        });
      }
    }
    return true;
  }

  /** Clave de la ventana global: rl:{ip}:{userId|anon}:{método}:{ruta}. */
  private buildKey(req: RateLimitedRequest): string {
    const ip = this.resolveIp(req);
    const subject = req.user?.userId ?? 'anon';
    const route = req.route?.path ?? req.originalUrl ?? req.url ?? 'unknown';
    const method = req.method ?? 'GET';
    return `veo:driver-bff:rl:${ip}:${subject}:${method}:${route}`;
  }

  /**
   * Clave compuesta para overrides @RateLimit: concatena los segmentos pedidos en `by`
   * (default ['ip','user']). `route` (método:ruta) SIEMPRE se incluye para no mezclar contadores
   * entre endpoints. `phone` se toma del body (normalizado) → limitar por IP+teléfono en el OTP.
   * Mismo formato que public-bff (coherencia entre BFFs).
   */
  private compositeKey(req: RateLimitedRequest, by: RateLimitBy[] = ['ip', 'user']): string {
    const route = `${req.method ?? 'GET'}:${req.route?.path ?? req.originalUrl ?? req.url ?? 'unknown'}`;
    const parts = by.map((field) => {
      switch (field) {
        case 'ip':
          return `ip=${this.resolveIp(req)}`;
        case 'user':
          return `u=${req.user?.userId ?? 'anon'}`;
        case 'phone':
          return `ph=${this.phoneKey(req)}`;
        case 'route':
          return `r=${route}`;
        default:
          return '';
      }
    });
    if (!by.includes('route')) parts.push(`r=${route}`);
    return parts.join(':');
  }

  /** Lee un campo string del body y lo normaliza (trim + minúsculas). 'none' si falta o no es string. */
  private bodyField(req: RateLimitedRequest, key: string): string {
    const value = req.body?.[key];
    return typeof value === 'string' ? value.trim().toLowerCase() : 'none';
  }

  /**
   * Key del teléfono: lo CANONICALIZA a `+51XXXXXXXXX` (forma de `peruPhoneSchema`/identity) para que
   * las 3 representaciones del MISMO número (`9…`, `519…`, `+519…`) colapsen a UNA key y compartan el
   * cubo — sin esto el cap fino IP+phone es franqueable Nx (un cubo fresco por representación). Si no
   * es un teléfono peruano válido, cae al trim+lower de `bodyField` (no inventamos canon para basura).
   */
  private phoneKey(req: RateLimitedRequest): string {
    const value = req.body?.['phone'];
    if (typeof value !== 'string') return 'none';
    return canonicalizePeruPhone(value) ?? value.trim().toLowerCase();
  }

  /**
   * IP real del cliente = `req.ip`, resuelta por Express vía `trust proxy` (ver main.ts): camina el
   * `X-Forwarded-For` descartando los hops de proxy de confianza (ALB + ingress-nginx, IP privada) y
   * deja la primera IP PÚBLICA = el cliente real. NO leemos `x-forwarded-for` crudo: sería SPOOFEABLE
   * (un atacante lo inyecta y obtiene un cubo de rate-limit fresco por request, evadiendo el límite).
   */
  private resolveIp(req: RateLimitedRequest): string {
    return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  }
}
