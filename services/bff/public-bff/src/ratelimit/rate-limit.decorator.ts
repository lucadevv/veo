import { SetMetadata } from '@nestjs/common';

/** Clave de metadata para el override de rate limit por ruta. */
export const RATE_LIMIT_KEY = 'veo:rateLimit';

/**
 * Campos que componen la identidad de limitación de un endpoint.
 *  - `ip`    → IP del cliente (siempre recomendable como ancla).
 *  - `user`  → userId autenticado (o 'anon' en endpoints pre-auth).
 *  - `phone` → campo `phone` del body (normalizado): para OTP por SMS por IP+teléfono.
 *  - `email` → campo `email` del body (normalizado): para login/registro por correo.
 *  - `route` → método:ruta (incluido por defecto si la lista queda vacía).
 */
export type RateLimitBy = 'ip' | 'user' | 'phone' | 'email' | 'route';

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
 * Override de rate limit por ruta (hardening L1). Endurece rutas de auth sensibles a fuerza bruta
 * por encima del límite global (120/min). El guard global (`RateLimitGuard`) lee esta metadata y, si
 * existe, usa estos `max`/`windowMs`/`by` en lugar de la config global.
 *
 * IMPORTANTE — esto es la CAPA DE BORDE del BFF, NO reemplaza el cooldown/lockout PROPIO de
 * identity-service (que protege el recurso interno OTP por teléfono). Doble defensa:
 *  - identity: cooldown de reenvío 30s + maxAttempts por teléfono sobre el OTP en Redis (recurso).
 *  - BFF (acá): límite por IP+teléfono en el borde, antes de tocar identity (frena floods baratos).
 *
 * Acepta UN límite o un ARREGLO de límites. Con varios, el guard los aplica TODOS en la misma request
 * (cada uno su cubo independiente) y bloquea si CUALQUIERA excede (AND lógico). Esto permite limitar
 * por dos dimensiones a la vez — ej. OTP: un cap fino por IP+teléfono Y un cap AGREGADO por-IP sobre
 * el total de teléfonos (anti SMS-bombing fan-out, FIX A).
 *
 * Ej: `@RateLimit({ max: 5, windowMs: 600_000, by: ['ip', 'phone'] })` → 5 cada 10min por IP+teléfono.
 * Ej: `@RateLimit([{ max: 5, ..., by: ['ip','phone'] }, { max: 20, ..., by: ['ip'] }])` → ambos a la vez.
 */
export const RateLimit = (
  options: RateLimitOptions | RateLimitOptions[],
): MethodDecorator & ClassDecorator => SetMetadata(RATE_LIMIT_KEY, options);
