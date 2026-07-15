import {
  BPS_DENOMINATOR,
  FALLBACK_COMMISSION_RATE,
  commissionPercent,
  commissionRateFromBps,
  computeTripEarnings,
} from '../value-objects/trip-earnings';

describe('computeTripEarnings', () => {
  it('sin tasa inyectada usa el FALLBACK offline 20% (default del backend, jamás la fuente de verdad)', () => {
    const e = computeTripEarnings(1450);
    expect(e.fareCents).toBe(1450);
    expect(e.commissionCents).toBe(290); // round(1450 * 0.20) = 290
    expect(e.netCents).toBe(1160); // 1450 - 290
    expect(e.commissionRate).toBe(FALLBACK_COMMISSION_RATE);
  });

  it('aplica la tasa VIGENTE del servidor (2000 bps → 20%) plegada por commissionRateFromBps', () => {
    const e = computeTripEarnings(1000, commissionRateFromBps(2000));
    expect(e.commissionCents).toBe(200);
    expect(e.netCents).toBe(800);
    expect(e.commissionRate).toBe(0.2);
  });

  it('una tasa del panel distinta al default se refleja tal cual (1250 bps → 12.5%)', () => {
    const e = computeTripEarnings(2000, commissionRateFromBps(1250));
    expect(e.commissionRate).toBe(0.125);
    expect(e.commissionCents).toBe(250); // round(2000 * 0.125)
    expect(e.netCents).toBe(1750);
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
});

describe('commissionRateFromBps', () => {
  it('pliega bps del servidor a fracción 0..1', () => {
    expect(commissionRateFromBps(2000)).toBe(0.2);
    expect(commissionRateFromBps(0)).toBe(0);
    expect(commissionRateFromBps(BPS_DENOMINATOR)).toBe(1);
  });

  it('sin dato (query cargando / offline) degrada al fallback 20%', () => {
    expect(commissionRateFromBps(undefined)).toBe(FALLBACK_COMMISSION_RATE);
  });

  it('un bps fuera de contrato degrada al fallback (nunca NaN ni tasa negativa/>100%)', () => {
    for (const bad of [Number.NaN, -1, BPS_DENOMINATOR + 1, Number.POSITIVE_INFINITY]) {
      expect(commissionRateFromBps(bad)).toBe(FALLBACK_COMMISSION_RATE);
    }
  });
});

describe('commissionPercent', () => {
  it('devuelve puntos porcentuales enteros (default = fallback 20)', () => {
    expect(commissionPercent()).toBe(20);
    expect(commissionPercent(0.125)).toBe(13); // redondeo a entero para la etiqueta
    expect(commissionPercent(commissionRateFromBps(2000))).toBe(20);
  });
});
