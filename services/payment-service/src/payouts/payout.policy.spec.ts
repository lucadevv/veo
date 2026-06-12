import { describe, it, expect } from 'vitest';
import {
  aggregatePayouts,
  assertPayoutTransition,
  canTransitionPayout,
  discrepancyPct,
  periodLabel,
} from './payout.policy';

describe('aggregatePayouts (BR-P05)', () => {
  it('agrega por conductor: neto = (bruto − comisión) + propinas', () => {
    const rows = [
      { driverId: 'd1', grossCents: 2000, commissionCents: 400, tipCents: 300 },
      { driverId: 'd1', grossCents: 3000, commissionCents: 600, tipCents: 0 },
    ];
    const [p] = aggregatePayouts(rows, 0);
    expect(p).toEqual({ driverId: 'd1', grossCents: 5000, commissionCents: 1000, amountCents: 4300 });
  });

  it('excluye conductores bajo el mínimo liquidable (S/50 = 5000)', () => {
    const rows = [
      { driverId: 'low', grossCents: 4000, commissionCents: 800, tipCents: 0 }, // neto 3200 < 5000
      { driverId: 'ok', grossCents: 8000, commissionCents: 1600, tipCents: 0 }, // neto 6400 >= 5000
    ];
    const result = aggregatePayouts(rows, 5000);
    expect(result.map((p) => p.driverId)).toEqual(['ok']);
  });

  it('F2.3 · la compensación de penalidad entra NETA al amount, sin inflar bruto ni comisión', () => {
    const rows = [
      { driverId: 'd1', grossCents: 2000, commissionCents: 400, tipCents: 0 }, // neto viaje 1600
      { driverId: 'd1', grossCents: 0, commissionCents: 0, tipCents: 0, compensationCents: 400 }, // +400 neto
    ];
    const [p] = aggregatePayouts(rows, 0);
    // grossCents/commissionCents = SOLO la tarifa; amountCents = 1600 + 400 (comp) = 2000.
    expect(p).toEqual({ driverId: 'd1', grossCents: 2000, commissionCents: 400, amountCents: 2000 });
  });

  it('el bono de incentivo entra NETO al amount, sin inflar bruto ni comisión', () => {
    const rows = [
      { driverId: 'd1', grossCents: 2000, commissionCents: 400, tipCents: 0 }, // neto viaje 1600
      { driverId: 'd1', grossCents: 0, commissionCents: 0, tipCents: 0, incentiveCents: 1500 }, // +1500 bono
    ];
    const [p] = aggregatePayouts(rows, 0);
    // grossCents/commissionCents = SOLO la tarifa; amountCents = 1600 + 1500 (bono) = 3100.
    expect(p).toEqual({ driverId: 'd1', grossCents: 2000, commissionCents: 400, amountCents: 3100 });
  });

  it('bono + compensación coexisten, ambos netos y sumados (semánticas separadas)', () => {
    const rows = [
      { driverId: 'd1', grossCents: 0, commissionCents: 0, tipCents: 0, compensationCents: 400, incentiveCents: 1500 },
    ];
    const [p] = aggregatePayouts(rows, 0);
    expect(p).toEqual({ driverId: 'd1', grossCents: 0, commissionCents: 0, amountCents: 1900 });
  });

  it('un bono solo puede alcanzar el mínimo liquidable por sí mismo (back-pay de un histórico)', () => {
    const rows = [{ driverId: 'only-bonus', grossCents: 0, commissionCents: 0, tipCents: 0, incentiveCents: 5000 }];
    const [p] = aggregatePayouts(rows, 5000);
    expect(p).toEqual({ driverId: 'only-bonus', grossCents: 0, commissionCents: 0, amountCents: 5000 });
  });

  it('F2.3 · una compensación de penalidad sola puede alcanzar el mínimo liquidable por sí misma', () => {
    const rows = [
      { driverId: 'only-penalty', grossCents: 0, commissionCents: 0, tipCents: 0, compensationCents: 5000 },
    ];
    const [p] = aggregatePayouts(rows, 5000);
    expect(p).toEqual({ driverId: 'only-penalty', grossCents: 0, commissionCents: 0, amountCents: 5000 });
  });

  it('es determinista (ordenado por driverId)', () => {
    const rows = [
      { driverId: 'b', grossCents: 10000, commissionCents: 2000, tipCents: 0 },
      { driverId: 'a', grossCents: 10000, commissionCents: 2000, tipCents: 0 },
    ];
    expect(aggregatePayouts(rows, 0).map((p) => p.driverId)).toEqual(['a', 'b']);
  });
});

describe('discrepancyPct (BR-P07)', () => {
  it('0% cuando DB y extracto coinciden', () => {
    expect(discrepancyPct(100000, 100000)).toBe(0);
  });

  it('calcula la fracción de diferencia', () => {
    expect(discrepancyPct(100000, 99000)).toBeCloseTo(0.01, 5);
    expect(discrepancyPct(100000, 98000)).toBeCloseTo(0.02, 5);
  });

  it('ambos en cero → 0', () => {
    expect(discrepancyPct(0, 0)).toBe(0);
  });
});

describe('máquina de estados del payout (S4)', () => {
  it('HELD → PROCESSED es válida (liberación de la retención, review resuelto)', () => {
    expect(canTransitionPayout('HELD', 'PROCESSED')).toBe(true);
    expect(() => assertPayoutTransition('HELD', 'PROCESSED')).not.toThrow();
  });

  it('PROCESSED es terminal: no vuelve a HELD ni a PENDING', () => {
    expect(canTransitionPayout('PROCESSED', 'HELD')).toBe(false);
    expect(canTransitionPayout('PROCESSED', 'PENDING')).toBe(false);
    expect(() => assertPayoutTransition('PROCESSED', 'HELD')).toThrow('Transición de payout inválida');
  });

  it('HELD no puede caer a FAILED en silencio (liberar = pagar, no fallar)', () => {
    expect(canTransitionPayout('HELD', 'FAILED')).toBe(false);
  });

  it('misma → misma es no-op válido (idempotencia)', () => {
    expect(canTransitionPayout('HELD', 'HELD')).toBe(true);
  });
});

describe('periodLabel', () => {
  it('formatea YYYY-MM-DD/YYYY-MM-DD', () => {
    expect(periodLabel(new Date('2026-05-18T00:00:00Z'), new Date('2026-05-25T00:00:00Z'))).toBe(
      '2026-05-18/2026-05-25',
    );
  });
});
