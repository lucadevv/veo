/**
 * FIX 2 (hardening L1) — los endpoints OAuth (@Public POST /auth/oauth/google|apple) son superficie
 * de fuerza bruta/abuso y deben llevar @RateLimit en el borde, igual que otp/request y email/login.
 * Verificamos la metadata del decorator sobre el handler.
 */
import { describe, it, expect } from 'vitest';
import { Reflector } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { RATE_LIMIT_KEY, type RateLimitOptions } from '../ratelimit/rate-limit.decorator';

const reflector = new Reflector();

function rateLimitOf(handler: (...args: never[]) => unknown): RateLimitOptions | undefined {
  return reflector.get<RateLimitOptions>(RATE_LIMIT_KEY, handler);
}

describe('AuthController · rate-limit en OAuth', () => {
  it('oauth/google tiene @RateLimit por IP (10 cada 10min)', () => {
    const opts = rateLimitOf(AuthController.prototype.loginWithGoogle);
    expect(opts).toBeDefined();
    expect(opts).toMatchObject({ max: 10, windowMs: 600_000, by: ['ip'] });
  });

  it('oauth/apple tiene @RateLimit por IP (10 cada 10min)', () => {
    const opts = rateLimitOf(AuthController.prototype.loginWithApple);
    expect(opts).toBeDefined();
    expect(opts).toMatchObject({ max: 10, windowMs: 600_000, by: ['ip'] });
  });
});
