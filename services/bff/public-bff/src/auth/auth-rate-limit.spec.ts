/**
 * FIX A + B (hardening L2) — cobertura per-método de los endpoints de auth que disparan correo/SMS o
 * consumen códigos por fuerza bruta. Verificamos la metadata @RateLimit sobre cada handler:
 *  - otp/request: ARREGLO de límites (cap fino IP+phone Y cap AGREGADO por-IP, anti SMS-bombing).
 *  - email/resend|verify|reset: caps per-método que antes caían solo al global laxo (120/min).
 */
import { describe, it, expect } from 'vitest';
import { Reflector } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { RATE_LIMIT_KEY, type RateLimitOptions } from '../ratelimit/rate-limit.decorator';

const reflector = new Reflector();
const TEN_MIN = 600_000;
const HOUR = 3_600_000;

function rateLimitOf(
  handler: (...args: never[]) => unknown,
): RateLimitOptions | RateLimitOptions[] | undefined {
  return reflector.get<RateLimitOptions | RateLimitOptions[]>(RATE_LIMIT_KEY, handler);
}

describe('AuthController public-bff · rate-limit per-método (FIX A + B)', () => {
  it('FIX A · otp/request lleva DOS límites: cap fino IP+phone Y cap agregado por-IP', () => {
    const opts = rateLimitOf(AuthController.prototype.requestOtp);
    expect(Array.isArray(opts)).toBe(true);
    expect(opts).toEqual([
      { max: 5, windowMs: TEN_MIN, by: ['ip', 'phone'] },
      { max: 20, windowMs: TEN_MIN, by: ['ip'] },
    ]);
  });

  it('FIX A · el segundo límite del OTP es AGREGADO por-IP (by SIN phone) → techo del fan-out', () => {
    const opts = rateLimitOf(AuthController.prototype.requestOtp) as RateLimitOptions[];
    const aggregate = opts[1] as RateLimitOptions;
    expect(aggregate.by).toEqual(['ip']);
    expect(aggregate.by).not.toContain('phone'); // sin phone → todos los teléfonos comparten cubo
  });

  it('FIX B · email/resend tiene cap estricto (3/hora por IP+email, como forgot)', () => {
    expect(rateLimitOf(AuthController.prototype.resendEmail)).toMatchObject({
      max: 3,
      windowMs: HOUR,
      by: ['ip', 'email'],
    });
  });

  it('FIX B · email/verify tiene cap anti-bruteforce (10/10min por IP+email)', () => {
    expect(rateLimitOf(AuthController.prototype.verifyEmail)).toMatchObject({
      max: 10,
      windowMs: TEN_MIN,
      by: ['ip', 'email'],
    });
  });

  it('FIX B · email/reset tiene cap anti-bruteforce (10/10min por IP+email)', () => {
    expect(rateLimitOf(AuthController.prototype.resetPassword)).toMatchObject({
      max: 10,
      windowMs: TEN_MIN,
      by: ['ip', 'email'],
    });
  });

  /* ── FIX 2 · refresh/logout YA NO caen al global laxo: cap per-método por IP (espeja driver-bff). ── */
  it('FIX 2 · refresh tiene cap per-método (30/10min por IP) — no cae al global laxo', () => {
    expect(rateLimitOf(AuthController.prototype.refresh)).toMatchObject({
      max: 30,
      windowMs: TEN_MIN,
      by: ['ip'],
    });
  });

  it('FIX 2 · logout tiene cap per-método (30/10min por IP) — no cae al global laxo', () => {
    expect(rateLimitOf(AuthController.prototype.logout)).toMatchObject({
      max: 30,
      windowMs: TEN_MIN,
      by: ['ip'],
    });
  });
});
