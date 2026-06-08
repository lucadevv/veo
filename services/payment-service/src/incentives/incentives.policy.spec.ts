import { describe, expect, it } from 'vitest';
import { computeCompleted, isActiveAt, isMetaCompleted, isWithinPeak } from './incentives.policy';

describe('incentives.policy', () => {
  describe('isActiveAt', () => {
    const now = new Date('2026-05-30T12:00:00Z');
    it('inactivo si active=false', () => {
      expect(isActiveAt({ active: false, startsAt: null, endsAt: null }, now)).toBe(false);
    });
    it('activo dentro de la ventana', () => {
      expect(
        isActiveAt(
          { active: true, startsAt: new Date('2026-05-30T00:00:00Z'), endsAt: new Date('2026-05-31T00:00:00Z') },
          now,
        ),
      ).toBe(true);
    });
    it('inactivo antes de startsAt o después de endsAt', () => {
      expect(isActiveAt({ active: true, startsAt: new Date('2026-05-31T00:00:00Z'), endsAt: null }, now)).toBe(false);
      expect(isActiveAt({ active: true, startsAt: null, endsAt: new Date('2026-05-29T00:00:00Z') }, now)).toBe(false);
    });
  });

  describe('isWithinPeak', () => {
    it('dentro de la franja 18:00-21:00', () => {
      const at = new Date('2026-05-30T19:30:00');
      expect(isWithinPeak({ peakStartMinute: 18 * 60, peakEndMinute: 21 * 60 }, at)).toBe(true);
    });
    it('fuera de la franja', () => {
      const at = new Date('2026-05-30T10:00:00');
      expect(isWithinPeak({ peakStartMinute: 18 * 60, peakEndMinute: 21 * 60 }, at)).toBe(false);
    });
    it('soporta franjas que cruzan medianoche (22:00-02:00)', () => {
      expect(isWithinPeak({ peakStartMinute: 22 * 60, peakEndMinute: 2 * 60 }, new Date('2026-05-30T23:00:00'))).toBe(true);
      expect(isWithinPeak({ peakStartMinute: 22 * 60, peakEndMinute: 2 * 60 }, new Date('2026-05-30T01:00:00'))).toBe(true);
      expect(isWithinPeak({ peakStartMinute: 22 * 60, peakEndMinute: 2 * 60 }, new Date('2026-05-30T12:00:00'))).toBe(false);
    });
    it('false si faltan límites', () => {
      expect(isWithinPeak({ peakStartMinute: null, peakEndMinute: null }, new Date())).toBe(false);
    });
  });

  describe('isMetaCompleted', () => {
    it('cumplida cuando tripsCompleted ≥ targetTrips', () => {
      expect(isMetaCompleted({ type: 'META_VIAJES', targetTrips: 10 }, 10)).toBe(true);
      expect(isMetaCompleted({ type: 'META_VIAJES', targetTrips: 10 }, 9)).toBe(false);
    });
    it('HORA_PICO nunca cumple por meta', () => {
      expect(isMetaCompleted({ type: 'HORA_PICO', targetTrips: 0 }, 100)).toBe(false);
    });
  });

  describe('computeCompleted', () => {
    it('META_VIAJES: completed según progreso', () => {
      const inc = { type: 'META_VIAJES' as const, targetTrips: 3, peakStartMinute: null, peakEndMinute: null };
      expect(computeCompleted(inc, { tripsCompleted: 3 }, new Date())).toBe(true);
      expect(computeCompleted(inc, { tripsCompleted: 1 }, new Date())).toBe(false);
      expect(computeCompleted(inc, null, new Date())).toBe(false);
    });
    it('HORA_PICO: completed según franja activa', () => {
      const inc = { type: 'HORA_PICO' as const, targetTrips: 0, peakStartMinute: 18 * 60, peakEndMinute: 21 * 60 };
      expect(computeCompleted(inc, null, new Date('2026-05-30T19:00:00'))).toBe(true);
      expect(computeCompleted(inc, null, new Date('2026-05-30T09:00:00'))).toBe(false);
    });
  });
});
