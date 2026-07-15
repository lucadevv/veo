/**
 * Guard de rate limiting (Redis) por IP + usuario + ruta, con ventanas configurables.
 * Se monta global DESPUÉS del JwtAuthGuard (para conocer al usuario). Los endpoints marcados
 * con @SkipRateLimit() — POST /panic — nunca se limitan.
 */
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { RateLimitError, canonicalizePeruPhone } from '@veo/utils';
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
    // Si existe, USA su(s) límite(s)/ventana(s)/clave(s) en vez de la config global. Puede ser UN
    // límite o un ARREGLO: con varios se aplican TODOS (cada uno su cubo) y basta que UNO exceda para
    // bloquear (FIX A: cap fino IP+phone Y cap agregado por-IP sobre el fan-out de SMS).
    const override = this.reflector.getAllAndOverride<RateLimitOptions | RateLimitOptions[]>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );

    const limits: Array<RateLimitOptions | undefined> = override
      ? Array.isArray(override)
        ? override
        : [override]
      : [undefined]; // undefined → el limiter cae a la config global.

    for (const limit of limits) {
      // Prefijo 'o' + clave compuesta (incluye `by`): cada dimensión — ['ip','phone'] vs ['ip'] —
      // tiene su PROPIO cubo, independiente del global.
      const id = limit ? `o:${this.compositeKey(req, limit.by)}` : this.identityFor(req);
      const result = await this.limiter.consume(
        id,
        limit ? { max: limit.max, windowMs: limit.windowMs } : undefined,
      );
      if (!result.allowed) {
        throw new RateLimitError('Demasiadas solicitudes, intenta más tarde', {
          limit: result.limit,
        });
      }
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
   * IP real del cliente = `req.ip`, resuelta por Express vía `trust proxy` (ver main.ts): camina el
   * `X-Forwarded-For` descartando los hops de proxy de confianza (ALB + ingress-nginx, IP privada) y
   * deja la primera IP PÚBLICA = el cliente real (un-spoofeable). ESTE es el fix del follow-up C2.
   * NO leemos headers crudos: `x-forwarded-for`/`cf-connecting-ip` son SPOOFEABLES (un atacante los
   * inyecta y obtiene un cubo de rate-limit fresco por request, brute-forceando el login sin freno).
   * VEO NO usa Cloudflare hoy → no hay nadie de confianza escribiendo `cf-connecting-ip`.
   *
   * FOLLOW-UP (no aplica hoy): si VEO migra a Cloudflare, `cf-connecting-ip` solo será confiable
   * validando el peer TCP contra el allowlist oficial de IPs de CF (https://www.cloudflare.com/ips/)
   * o con Authenticated Origin Pulls — NUNCA leyéndolo crudo.
   */
  private clientIp(req: RequestLike): string {
    return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
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
          return `ph=${this.phoneKey(req)}`;
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

  /**
   * Key del teléfono: lo CANONICALIZA a `+51XXXXXXXXX` (forma de `peruPhoneSchema`/identity) para que
   * las 3 representaciones del MISMO número (`9…`, `519…`, `+519…`) colapsen a UNA key y compartan el
   * cubo — sin esto el cap fino IP+phone es franqueable Nx (un cubo fresco por representación). Si no
   * es un teléfono peruano válido, cae al trim+lower de `bodyField` (no inventamos canon para basura).
   */
  private phoneKey(req: RequestLike): string {
    const value = req.body?.['phone'];
    if (typeof value !== 'string') return 'none';
    return canonicalizePeruPhone(value) ?? value.trim().toLowerCase();
  }
}
