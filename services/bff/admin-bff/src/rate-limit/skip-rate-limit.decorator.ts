/** Marca un handler/controlador para excluirlo del RateLimitGuard. */
import { SetMetadata } from '@nestjs/common';

export const SKIP_RATE_LIMIT_KEY = 'veo:skipRateLimit';
export const SkipRateLimit = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_RATE_LIMIT_KEY, true);
