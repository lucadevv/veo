import { describe, it, expect } from 'vitest';
import { SystemClock, FixedClock, CLOCK, type Clock } from './clock.js';

describe('SystemClock · adaptador de producción', () => {
  it('now() devuelve ~Date.now() (milisegundos desde epoch)', () => {
    const clock: Clock = new SystemClock();
    const before = Date.now();
    const t = clock.now();
    const after = Date.now();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });
});

describe('FixedClock · adaptador de test (determinista)', () => {
  it('now() devuelve siempre el valor fijo, sin tocar el reloj real', () => {
    const clock = new FixedClock(1_700_000_000_000);
    expect(clock.now()).toBe(1_700_000_000_000);
    expect(clock.now()).toBe(1_700_000_000_000); // estable entre llamadas
  });

  it('advance(ms) mueve el reloj hacia adelante', () => {
    const clock = new FixedClock(1_000);
    clock.advance(500);
    expect(clock.now()).toBe(1_500);
    clock.advance(60_000);
    expect(clock.now()).toBe(61_500);
  });

  it('advance(ms) admite retroceso con valor negativo', () => {
    const clock = new FixedClock(10_000);
    clock.advance(-3_000);
    expect(clock.now()).toBe(7_000);
  });

  it('set(ms) posiciona el reloj en un instante absoluto', () => {
    const clock = new FixedClock(1_000);
    const target = Date.UTC(2026, 5, 20);
    clock.set(target);
    expect(clock.now()).toBe(target);
  });
});

describe('CLOCK · token de inyección', () => {
  it('es un Symbol único (no un magic string)', () => {
    expect(typeof CLOCK).toBe('symbol');
    expect(CLOCK).toBe(CLOCK);
  });
});
