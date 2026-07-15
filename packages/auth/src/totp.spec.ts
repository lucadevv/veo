/**
 * TOTP determinista con reloj inyectado (FixedClock de @veo/utils).
 * Prueba que la clase de bug "el código depende del reloj de pared" murió: con un Clock fijo,
 * generar en T y verificar en T coincide a CUALQUIER instante (incl. 2026), y un código de T NO
 * verifica en T+60s (fuera de la ventana ±30s). Sin mockear Date, sin tocar el reloj real.
 */
import { describe, it, expect } from 'vitest';
import { FixedClock } from '@veo/utils';
import { enrollTotp, generateTotp, verifyTotp, isMfaFresh } from './totp.js';

describe('TOTP determinista con FixedClock (epoch inyectado por-llamada)', () => {
  it('código generado en T verifica en T — a un instante arbitrario', () => {
    const clock = new FixedClock(1_700_000_000_000);
    const { secret } = enrollTotp('op@veo.pe');

    const token = generateTotp(secret, clock.now());
    expect(verifyTotp(token, secret, clock.now())).toBe(true);
  });

  it('CLAVE: funciona en 2026 (FixedClock fijado a 2026-06-20) — no depende del reloj de pared', () => {
    const clock = new FixedClock(Date.UTC(2026, 5, 20));
    const { secret } = enrollTotp('op@veo.pe');

    const token = generateTotp(secret, clock.now());
    expect(verifyTotp(token, secret, clock.now())).toBe(true);
  });

  it('un código de T NO verifica en T+60s (fuera de la ventana ±30s)', () => {
    const clock = new FixedClock(Date.UTC(2026, 5, 20));
    const { secret } = enrollTotp('op@veo.pe');

    const token = generateTotp(secret, clock.now());
    clock.advance(60_000); // +60s → 2 ventanas adelante, fuera de window:1
    expect(verifyTotp(token, secret, clock.now())).toBe(false);
  });

  it('verificador y generador comparten el MISMO reloj inyectado → match a distintos instantes', () => {
    const { secret } = enrollTotp('op@veo.pe');
    for (const ms of [0, 1_000_000_000_000, Date.UTC(2030, 0, 1)]) {
      const clock = new FixedClock(ms);
      const token = generateTotp(secret, clock.now());
      expect(verifyTotp(token, secret, clock.now())).toBe(true);
    }
  });

  it('token mal formado (no 6 dígitos) → false sin tocar el verificador', () => {
    const clock = new FixedClock(Date.UTC(2026, 5, 20));
    const { secret } = enrollTotp('op@veo.pe');
    expect(verifyTotp('12345', secret, clock.now())).toBe(false);
    expect(verifyTotp('abcdef', secret, clock.now())).toBe(false);
  });

  it('NO muta el estado global del authenticator: dos relojes distintos no se contaminan', () => {
    const { secret } = enrollTotp('op@veo.pe');
    const past = new FixedClock(Date.UTC(2020, 0, 1));
    const future = new FixedClock(Date.UTC(2026, 5, 20));

    const tokenPast = generateTotp(secret, past.now());
    const tokenFuture = generateTotp(secret, future.now());

    // Cada token solo es válido en SU instante; el clone por-llamada los aísla.
    expect(verifyTotp(tokenPast, secret, past.now())).toBe(true);
    expect(verifyTotp(tokenFuture, secret, future.now())).toBe(true);
    expect(verifyTotp(tokenPast, secret, future.now())).toBe(false);
  });
});

describe('isMfaFresh con nowMs inyectado', () => {
  it('dentro de la antigüedad máxima → fresca', () => {
    const clock = new FixedClock(Date.UTC(2026, 5, 20));
    const mfaAtSec = Math.floor(clock.now() / 1000) - 100; // hace 100s
    expect(isMfaFresh(mfaAtSec, 300, clock.now())).toBe(true);
  });

  it('más vieja que la antigüedad máxima → NO fresca', () => {
    const clock = new FixedClock(Date.UTC(2026, 5, 20));
    const mfaAtSec = Math.floor(clock.now() / 1000) - 400; // hace 400s > 300s
    expect(isMfaFresh(mfaAtSec, 300, clock.now())).toBe(false);
  });

  it('sin verificación previa (undefined) → NO fresca', () => {
    const clock = new FixedClock(Date.UTC(2026, 5, 20));
    expect(isMfaFresh(undefined, 300, clock.now())).toBe(false);
  });
});
