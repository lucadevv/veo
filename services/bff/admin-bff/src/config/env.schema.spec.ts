/**
 * FIX D — RATE_LIMIT_MAX/RATE_LIMIT_WINDOW_MS deben ser enteros positivos: un 0/negativo/float
 * reventaría el limiter en runtime (o bloquearía TODO el tráfico), así que debe FALLAR al boot.
 */
import { describe, it, expect } from 'vitest';
import { validateEnv } from './env.schema';

describe('admin-bff env · RATE_LIMIT_* int().positive() (FIX D)', () => {
  it('acepta defaults válidos', () => {
    const env = validateEnv({});
    expect(env.RATE_LIMIT_MAX).toBe(120);
    expect(env.RATE_LIMIT_WINDOW_MS).toBe(60_000);
  });

  it('rechaza RATE_LIMIT_MAX=0 al boot', () => {
    expect(() => validateEnv({ RATE_LIMIT_MAX: '0' })).toThrow();
  });

  it('rechaza RATE_LIMIT_MAX negativo al boot', () => {
    expect(() => validateEnv({ RATE_LIMIT_MAX: '-5' })).toThrow();
  });

  it('rechaza RATE_LIMIT_WINDOW_MS float al boot', () => {
    expect(() => validateEnv({ RATE_LIMIT_WINDOW_MS: '1.5' })).toThrow();
  });

  it('rechaza RATE_LIMIT_WINDOW_MS=0 al boot', () => {
    expect(() => validateEnv({ RATE_LIMIT_WINDOW_MS: '0' })).toThrow();
  });
});
