import { describe, it, expect } from 'vitest';
import { RetryPolicy } from './retry.policy';

const baseCfg = { baseMs: 1_000, factor: 2, maxMs: 60_000, defaultMaxAttempts: 5, jitter: false };

describe('RetryPolicy (backoff exponencial)', () => {
  it('crece exponencialmente sin jitter', () => {
    const p = new RetryPolicy(baseCfg);
    expect(p.nextDelayMs(1)).toBe(1_000);
    expect(p.nextDelayMs(2)).toBe(2_000);
    expect(p.nextDelayMs(3)).toBe(4_000);
    expect(p.nextDelayMs(4)).toBe(8_000);
  });

  it('aplica el tope maxMs', () => {
    const p = new RetryPolicy({ ...baseCfg, maxMs: 5_000 });
    expect(p.nextDelayMs(10)).toBe(5_000);
  });

  it('con jitter, el delay queda en [capped/2, capped]', () => {
    const p = new RetryPolicy({ ...baseCfg, jitter: true }, () => 0); // random()=0 → mitad inferior
    expect(p.nextDelayMs(3)).toBe(2_000); // 4000 * 0.5
    const pHigh = new RetryPolicy({ ...baseCfg, jitter: true }, () => 1); // random()=1 → tope
    expect(pHigh.nextDelayMs(3)).toBe(4_000);
  });

  it('detecta agotamiento de reintentos', () => {
    const p = new RetryPolicy(baseCfg);
    expect(p.isExhausted(2, 3)).toBe(false);
    expect(p.isExhausted(3, 3)).toBe(true);
    expect(p.isExhausted(4, 3)).toBe(true);
  });
});
