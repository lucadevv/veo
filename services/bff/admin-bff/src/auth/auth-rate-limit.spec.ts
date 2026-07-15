/**
 * FIX B (hardening L2) — cobertura per-método del refresh de admin (abuso de rotación). logout queda
 * @SkipRateLimit por decisión deliberada (cerrar sesión nunca debe ser rate-limiteado).
 */
import { describe, it, expect } from 'vitest';
import { Reflector } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { RATE_LIMIT_KEY, type RateLimitOptions } from '../rate-limit/rate-limit.decorator';
import { SKIP_RATE_LIMIT_KEY } from '../rate-limit/skip-rate-limit.decorator';

const reflector = new Reflector();
const TEN_MIN = 600_000;

describe('AuthController admin-bff · rate-limit per-método (FIX B)', () => {
  it('refresh tiene cap per-método (30/10min por IP)', () => {
    const opts = reflector.get<RateLimitOptions>(RATE_LIMIT_KEY, AuthController.prototype.refresh);
    expect(opts).toMatchObject({ max: 30, windowMs: TEN_MIN, by: ['ip'] });
  });

  it('logout permanece @SkipRateLimit (decisión deliberada, no se rate-limitea cerrar sesión)', () => {
    const skip = reflector.get<boolean>(SKIP_RATE_LIMIT_KEY, AuthController.prototype.logout);
    expect(skip).toBe(true);
  });
});
