import { describe, it, expect } from 'vitest';
import { PricingMode } from '@veo/shared-types';
import {
  DEFAULT_SCHEDULE,
  resolveMode,
  toLimaTime,
  toZone,
  type PricingModeSchedule,
} from './pricing-mode';

// Bits de día (Lun=1, Mar=2, Mié=4, Jue=8, Vie=16, Sáb=32, Dom=64).
const MON = 1;
const TUE = 2;
const WED = 4;
const ALL_DAYS = 127;

describe('toLimaTime · UTC-5 fijo sin DST', () => {
  it('08:00 Lima = 13:00 UTC del mismo día', () => {
    // 2026-06-04 es JUEVES. 13:00 UTC → 08:00 Lima, jueves (weekday 4).
    const { weekday, minuteOfDay } = toLimaTime(new Date('2026-06-04T13:00:00.000Z'));
    expect(weekday).toBe(4); // jueves
    expect(minuteOfDay).toBe(8 * 60); // 480
  });

  it('cruza la medianoche hacia atrás: 02:00 UTC → 21:00 del día ANTERIOR en Lima', () => {
    // 2026-06-04T02:00Z (jueves UTC) → 2026-06-03 21:00 Lima (MIÉRCOLES, weekday 3).
    const { weekday, minuteOfDay } = toLimaTime(new Date('2026-06-04T02:00:00.000Z'));
    expect(weekday).toBe(3); // miércoles
    expect(minuteOfDay).toBe(21 * 60); // 1260
  });
});

describe('resolveMode · ADR 011 §1.1 (decisión pura)', () => {
  it('una regla que matchea (día + hora local de Lima) → su modo', () => {
    // Regla FIXED Lun-Dom 07:00–10:00 Lima. 2026-06-04T13:00Z = 08:00 Lima jueves → matchea.
    const schedule: PricingModeSchedule = {
      defaultMode: PricingMode.PUJA,
      rules: [{ dayMask: ALL_DAYS, startMinute: 7 * 60, endMinute: 10 * 60, mode: PricingMode.FIXED }],
    };
    const mode = resolveMode(schedule, 'GLOBAL', new Date('2026-06-04T13:00:00.000Z'));
    expect(mode).toBe(PricingMode.FIXED);
  });

  it('boundary: regla 7:00–10:00 matchea 08:00 Lima = 13:00 UTC', () => {
    const schedule: PricingModeSchedule = {
      defaultMode: PricingMode.PUJA,
      rules: [{ dayMask: ALL_DAYS, startMinute: 420, endMinute: 600, mode: PricingMode.FIXED }],
    };
    // start inclusive (07:00 = 12:00 UTC), end exclusive (10:00 = 15:00 UTC).
    expect(resolveMode(schedule, 'GLOBAL', new Date('2026-06-04T12:00:00.000Z'))).toBe(PricingMode.FIXED);
    expect(resolveMode(schedule, 'GLOBAL', new Date('2026-06-04T13:00:00.000Z'))).toBe(PricingMode.FIXED);
    // 10:00 Lima (15:00 UTC) es EXCLUSIVO → no matchea → defaultMode PUJA.
    expect(resolveMode(schedule, 'GLOBAL', new Date('2026-06-04T15:00:00.000Z'))).toBe(PricingMode.PUJA);
  });

  it('ninguna regla matchea (fuera de hora) → defaultMode', () => {
    const schedule: PricingModeSchedule = {
      defaultMode: PricingMode.PUJA,
      rules: [{ dayMask: ALL_DAYS, startMinute: 7 * 60, endMinute: 10 * 60, mode: PricingMode.FIXED }],
    };
    // 18:00 UTC = 13:00 Lima → fuera de 07:00–10:00 → default PUJA.
    expect(resolveMode(schedule, 'GLOBAL', new Date('2026-06-04T18:00:00.000Z'))).toBe(PricingMode.PUJA);
  });

  it('ninguna regla matchea (día equivocado) → defaultMode', () => {
    // Regla solo Lun-Mar; 2026-06-04 es jueves → no matchea por día.
    const schedule: PricingModeSchedule = {
      defaultMode: PricingMode.PUJA,
      rules: [{ dayMask: MON | TUE, startMinute: 0, endMinute: 1439, mode: PricingMode.FIXED }],
    };
    expect(resolveMode(schedule, 'GLOBAL', new Date('2026-06-04T13:00:00.000Z'))).toBe(PricingMode.PUJA);
  });

  it('schedule vacío → defaultMode', () => {
    const schedule: PricingModeSchedule = { defaultMode: PricingMode.FIXED, rules: [] };
    expect(resolveMode(schedule, 'GLOBAL', new Date('2026-06-04T13:00:00.000Z'))).toBe(PricingMode.FIXED);
  });

  it('DEFAULT_SCHEDULE (sin schedule cargado) → FIXED (B5: default de sistema = precio fijo)', () => {
    expect(resolveMode(DEFAULT_SCHEDULE, 'GLOBAL', new Date('2026-06-04T13:00:00.000Z'))).toBe(
      PricingMode.FIXED,
    );
  });

  it('la PRIMERA regla que matchea gana (orden de evaluación)', () => {
    const schedule: PricingModeSchedule = {
      defaultMode: PricingMode.PUJA,
      rules: [
        { dayMask: ALL_DAYS, startMinute: 0, endMinute: 1439, mode: PricingMode.FIXED },
        { dayMask: ALL_DAYS, startMinute: 0, endMinute: 1439, mode: PricingMode.PUJA },
      ],
    };
    expect(resolveMode(schedule, 'GLOBAL', new Date('2026-06-04T13:00:00.000Z'))).toBe(PricingMode.FIXED);
  });

  it('rango overnight (end <= start) NO matchea (MVP same-day) → defaultMode', () => {
    const schedule: PricingModeSchedule = {
      defaultMode: PricingMode.PUJA,
      rules: [{ dayMask: ALL_DAYS, startMinute: 1300, endMinute: 200, mode: PricingMode.FIXED }],
    };
    // 13:00 Lima (18:00 UTC): aunque > 1300, el rango invertido se ignora → default PUJA.
    expect(resolveMode(schedule, 'GLOBAL', new Date('2026-06-04T18:00:00.000Z'))).toBe(PricingMode.PUJA);
  });

  it('matchea por día específico (miércoles) en hora local de Lima', () => {
    // 2026-06-04T02:00Z = miércoles 21:00 Lima. Regla WED 20:00–22:00 → matchea.
    const schedule: PricingModeSchedule = {
      defaultMode: PricingMode.PUJA,
      rules: [{ dayMask: WED, startMinute: 20 * 60, endMinute: 22 * 60, mode: PricingMode.FIXED }],
    };
    expect(resolveMode(schedule, 'GLOBAL', new Date('2026-06-04T02:00:00.000Z'))).toBe(PricingMode.FIXED);
  });
});

describe('toZone · MVP Tier 1 GLOBAL', () => {
  it('siempre devuelve GLOBAL (la zona se ignora en el MVP)', () => {
    expect(toZone({ lat: -12.0464, lon: -77.0428 })).toBe('GLOBAL');
    expect(toZone({ lat: 0, lon: 0 })).toBe('GLOBAL');
  });
});
