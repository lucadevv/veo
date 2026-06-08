import { SetMetadata } from '@nestjs/common';

/** Clave de metadata para excluir un handler del rate limiting (p.ej. POST /panic). */
export const SKIP_RATE_LIMIT_KEY = 'veo:skipRateLimit';

/**
 * Excluye un endpoint del rate limiter. Uso obligatorio en POST /panic: una alerta de pánico
 * JAMÁS debe ser limitada (FOUNDATION §14, BR-S04/S05).
 */
export const SkipRateLimit = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_RATE_LIMIT_KEY, true);
