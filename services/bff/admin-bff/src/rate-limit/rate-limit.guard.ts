/**
 * RateLimitGuard — limitación con Redis por IP + usuario + MÉTODO + ruta (ventana FIJA).
 * Decisión FOUNDATION §14: rate-limit en los BFFs (Redis). El admin-bff no recibe POST /panic crudo,
 * así que aquí no hay excepción de pánico; sí se exceptúan health/metrics.
 *
 * El INCR + EXPIRE es ATÓMICO (un solo script Lua vía `consumeFixedWindow` de @veo/utils, COMPARTIDO
 * por los 3 BFFs): imposible que una clave quede sin TTL (bucket permanente) por una caída entre
 * INCR y EXPIRE. ANTES esto era un sorted-set deslizante PROPIO (3ra implementación divergente) con
 * la clave SIN método:ruta (todos los endpoints compartían cubo) — ambos cerrados acá.
 *
 * Override POR MÉTODO (ADR-012, FIX 6): un endpoint de auth (login/totp/invite) declara
 * `@RateLimit({...})` para un cap estricto por encima del global. El guard lee esa metadata.
 */
import { Injectable, Inject, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type Redis from 'ioredis';
import { RateLimitError, consumeFixedWindow } from '@veo/utils';
import type { AuthenticatedUser } from '@veo/auth';
import { REDIS } from '../infra/tokens';
import type { Env } from '../config/env.schema';
import { SKIP_RATE_LIMIT_KEY } from './skip-rate-limit.decorator';
import { RATE_LIMIT_KEY, type RateLimitBy, type RateLimitOptions } from './rate-limit.decorator';

interface RequestLike {
  ip?: string;
  method?: string;
  path?: string;
  url?: string;
  route?: { path?: string };
  user?: AuthenticatedUser;
  socket?: { remoteAddress?: string };
  body?: Record<string, unknown>;
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
    // getOrThrow (no get con infer): fail-fast si falta la config — alineado con driver/public-bff.
    this.windowMs = config.getOrThrow<number>('RATE_LIMIT_WINDOW_MS');
    this.max = config.getOrThrow<number>('RATE_LIMIT_MAX');
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

    // Override por ruta (decorator @RateLimit): endurece auth sensible a fuerza bruta POR MÉTODO.
    // Puede ser UN límite o un ARREGLO: con varios se aplican TODOS (cada uno su cubo) y basta que
    // UNO exceda para bloquear (AND lógico). Coherente con driver/public-bff.
    const override = this.reflector.getAllAndOverride<RateLimitOptions | RateLimitOptions[]>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );

    const limits: RateLimitOptions[] = override
      ? Array.isArray(override)
        ? override
        : [override]
      : [{ max: this.max, windowMs: this.windowMs }];

    for (const limit of limits) {
      const key = override
        ? `bff:admin:rl:o:${this.compositeKey(req, limit.by)}`
        : this.buildKey(req);

      const result = await consumeFixedWindow(this.redis, key, limit.max, limit.windowMs);
      if (!result.allowed) {
        throw new RateLimitError('Límite de peticiones excedido', {
          limit: limit.max,
          windowMs: limit.windowMs,
          retryAfterSeconds:
            Math.ceil(result.resetMs / 1000) || Math.ceil(limit.windowMs / 1000),
        });
      }
    }
    return true;
  }

  /**
   * Clave global: incluye MÉTODO + RUTA (FIX [5]). ANTES omitía método:ruta → TODOS los endpoints
   * compartían el mismo cubo por (ip, usuario), un endpoint ruidoso agotaba el límite de los demás.
   */
  private buildKey(req: RequestLike): string {
    const ip = this.clientIp(req);
    const subject = req.user?.userId ?? 'anon';
    const route = req.route?.path ?? req.path ?? req.url ?? 'unknown';
    const method = req.method ?? 'GET';
    return `bff:admin:rl:${ip}:${subject}:${method}:${route}`;
  }

  /**
   * Clave compuesta para overrides @RateLimit (mismo formato que driver/public-bff). `route`
   * (método:ruta) SIEMPRE se incluye. `email` se toma del body (normalizado) → limitar login por
   * IP+email.
   */
  private compositeKey(req: RequestLike, by: RateLimitBy[] = ['ip', 'user']): string {
    const route = `${req.method ?? 'GET'}:${req.route?.path ?? req.path ?? req.url ?? 'unknown'}`;
    const parts = by.map((field) => {
      switch (field) {
        case 'ip':
          return `ip=${this.clientIp(req)}`;
        case 'user':
          return `u=${req.user?.userId ?? 'anon'}`;
        case 'email':
          return `em=${this.bodyField(req, 'email')}`;
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
  private bodyField(req: RequestLike, key: string): string {
    const value = req.body?.[key];
    return typeof value === 'string' ? value.trim().toLowerCase() : 'none';
  }

  /**
   * IP real del cliente = `req.ip`, resuelta por Express vía `trust proxy` (ver main.ts): camina el
   * `X-Forwarded-For` descartando los hops de proxy de confianza (ALB + ingress-nginx, IP privada) y
   * deja la primera IP PÚBLICA = el cliente real. NO leemos headers crudos: serían SPOOFEABLES (un
   * atacante inyecta `x-forwarded-for`/`cf-connecting-ip` y obtiene un cubo de rate-limit fresco por
   * request). VEO NO usa Cloudflare hoy → no hay nadie de confianza escribiendo `cf-connecting-ip`.
   */
  private clientIp(req: RequestLike): string {
    return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  }
}
