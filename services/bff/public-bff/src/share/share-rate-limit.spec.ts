/**
 * FIX 2 (hardening L1) — los GET @Public anónimos parametrizados por :token son superficie de
 * enumeración/fuerza-bruta de tokens. El de /:token/video emite un FamilyVideoGrant (autorización
 * LiveKit al video EN VIVO del habitáculo) → ALTO valor: debe llevar @RateLimit duro por IP en el
 * borde. Verificamos la metadata del decorator sobre cada handler.
 */
import { describe, it, expect } from 'vitest';
import { Reflector } from '@nestjs/core';
import { PublicShareController } from './public-share.controller';
import { RATE_LIMIT_KEY, type RateLimitOptions } from '../ratelimit/rate-limit.decorator';

const reflector = new Reflector();

function rateLimitOf(handler: (...args: never[]) => unknown): RateLimitOptions | undefined {
  return reflector.get<RateLimitOptions>(RATE_LIMIT_KEY, handler);
}

describe('PublicShareController · rate-limit en GET anónimos por token', () => {
  it('GET /:token (vista) tiene @RateLimit por IP (30 cada 10min)', () => {
    const opts = rateLimitOf(PublicShareController.prototype.view);
    expect(opts).toBeDefined();
    expect(opts).toMatchObject({ max: 30, windowMs: 600_000, by: ['ip'] });
  });

  it('GET /:token/video (LiveKit, ALTO valor) tiene @RateLimit duro por IP (10 cada 10min)', () => {
    const opts = rateLimitOf(PublicShareController.prototype.video);
    expect(opts).toBeDefined();
    expect(opts).toMatchObject({ max: 10, windowMs: 600_000, by: ['ip'] });
  });
});
