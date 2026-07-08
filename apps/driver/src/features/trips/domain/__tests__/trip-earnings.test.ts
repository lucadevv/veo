import {
  VEO_COMMISSION_RATE,
  commissionPercent,
  computeTripEarnings,
} from '../value-objects/trip-earnings';

describe('computeTripEarnings', () => {
  it('descompone la tarifa en comisión 12% (redondeada) + neto', () => {
    const e = computeTripEarnings(1450);
    expect(e.fareCents).toBe(1450);
    expect(e.commissionCents).toBe(174); // round(1450 * 0.12) = 174
    expect(e.netCents).toBe(1276); // 1450 - 174
    expect(e.commissionRate).toBe(VEO_COMMISSION_RATE);
  });

  it('el neto + la comisión reconstruyen exactamente la tarifa (sin pérdida de céntimos)', () => {
    for (const fare of [0, 1, 99, 100, 333, 1450, 2599, 100000]) {
      const e = computeTripEarnings(fare);
      expect(e.commissionCents + e.netCents).toBe(e.fareCents);
    }
  });

  it('degrada una tarifa inválida/negativa a 0 (nunca NaN ni neto negativo)', () => {
    for (const bad of [Number.NaN, -500, Number.POSITIVE_INFINITY]) {
      const e = computeTripEarnings(bad);
      expect(e.fareCents).toBe(0);
      expect(e.commissionCents).toBe(0);
      expect(e.netCents).toBe(0);
    }
  });

  it('respeta una tasa de comisión inyectada', () => {
    const e = computeTripEarnings(1000, 0.2);
    expect(e.commissionCents).toBe(200);
    expect(e.netCents).toBe(800);
  });

  it('commissionPercent devuelve puntos porcentuales enteros', () => {
    expect(commissionPercent()).toBe(12);
    expect(commissionPercent(0.2)).toBe(20);
  });
});
