import { SetMetadata } from '@nestjs/common';

/** Clave de metadata para el override de rate limit por ruta. */
export const RATE_LIMIT_KEY = 'veo:rateLimit';

/**
 * Campos que componen la identidad de limitación de un endpoint (mismo contrato que public/driver-bff,
 * para no divergir entre BFFs).
 *  - `ip`    → IP del cliente (siempre recomendable como ancla).
 *  - `user`  → userId autenticado (o 'anon' en endpoints pre-auth).
 *  - `email` → campo `email` del body (normalizado): para login/invite por correo por IP+email.
 *  - `route` → método:ruta (incluido por defecto si la lista queda vacía).
 */
export type RateLimitBy = 'ip' | 'user' | 'email' | 'route';

export interface RateLimitOptions {
  /** Máximo de solicitudes permitidas dentro de la ventana. */
  max: number;
  /** Tamaño de la ventana en milisegundos. */
  windowMs: number;
  /**
   * Campos que componen la clave de limitación. Default: `['ip', 'user']`.
   * `route` (método:ruta) SIEMPRE se concatena para no mezclar contadores entre endpoints.
   */
  by?: RateLimitBy[];
}

/**
 * Override de rate limit por ruta (hardening L1, ADR-012). Endurece rutas de auth sensibles a fuerza
 * bruta POR MÉTODO por encima del cap global (120/min). El `RateLimitGuard` lee esta metadata y, si
 * existe, usa estos `max`/`windowMs`/`by` en lugar de la config global.
 *
 * Es la CAPA DE BORDE del BFF, NO reemplaza el lockout PROPIO de identity-service.
 *
 * Acepta UN límite o un ARREGLO de límites. Con varios, el guard los aplica TODOS en la misma request
 * (cada uno su cubo independiente) y bloquea si CUALQUIERA excede (AND lógico) — para limitar por dos
 * dimensiones a la vez. Coherente con driver/public-bff.
 *
 * Ej: `@RateLimit({ max: 5, windowMs: 600_000, by: ['ip', 'email'] })` → 5 cada 10min por IP+email.
 */
export const RateLimit = (
  options: RateLimitOptions | RateLimitOptions[],
): MethodDecorator & ClassDecorator => SetMetadata(RATE_LIMIT_KEY, options);
