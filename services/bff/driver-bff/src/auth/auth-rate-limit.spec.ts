/**
 * FIX A + B (hardening L2) — cobertura per-método de los endpoints de auth del conductor:
 *  - otp/request: ARREGLO de límites (cap fino IP+phone Y cap AGREGADO por-IP, anti SMS-bombing).
 *  - refresh/logout: caps per-método que antes caían solo al global laxo (120/min).
 */
import { describe, it, expect } from 'vitest';
import { Reflector } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { RATE_LIMIT_KEY, type RateLimitOptions } from '../common/guards/rate-limit.decorator';

const reflector = new Reflector();
const TEN_MIN = 600_000;

function rateLimitOf(
  handler: (...args: never[]) => unknown,
): RateLimitOptions | RateLimitOptions[] | undefined {
  return reflector.get<RateLimitOptions | RateLimitOptions[]>(RATE_LIMIT_KEY, handler);
}

describe('AuthController driver-bff · rate-limit per-método (FIX A + B)', () => {
  it('FIX A · otp/request lleva DOS límites: cap fino IP+phone Y cap agregado por-IP', () => {
    const opts = rateLimitOf(AuthController.prototype.requestOtp);
    expect(Array.isArray(opts)).toBe(true);
    expect(opts).toEqual([
      { max: 5, windowMs: TEN_MIN, by: ['ip', 'phone'] },
      { max: 20, windowMs: TEN_MIN, by: ['ip'] },
    ]);
  });

  it('FIX A · el segundo límite del OTP es AGREGADO por-IP (by SIN phone)', () => {
    const opts = rateLimitOf(AuthController.prototype.requestOtp) as RateLimitOptions[];
    const aggregate = opts[1] as RateLimitOptions;
    expect(aggregate.by).toEqual(['ip']);
    expect(aggregate.by).not.toContain('phone');
  });

  it('FIX B · refresh tiene cap per-método (30/10min por IP)', () => {
    expect(rateLimitOf(AuthController.prototype.refresh)).toMatchObject({
      max: 30,
      windowMs: TEN_MIN,
      by: ['ip'],
    });
  });

  it('FIX B · logout tiene cap per-método (30/10min por IP)', () => {
    expect(rateLimitOf(AuthController.prototype.logout)).toMatchObject({
      max: 30,
      windowMs: TEN_MIN,
      by: ['ip'],
    });
  });
});
