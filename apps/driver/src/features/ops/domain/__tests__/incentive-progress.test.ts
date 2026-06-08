import type {Incentive} from '../entities';
import {
  formatMultiplier,
  incentiveProgressFraction,
  incentiveProgressPercent,
  incentiveSortRank,
  incentiveState,
  incentiveTripsRemaining,
  isIncentiveExpired,
  isMultiplierIncentive,
} from '../value-objects/incentive-progress';

const now = new Date('2026-05-30T12:00:00.000Z');

function makeIncentive(overrides: Partial<Incentive> = {}): Incentive {
  return {
    id: 'inc-1',
    type: 'META_VIAJES',
    title: 'Meta de 20 viajes',
    description: 'Completa 20 viajes esta semana',
    targetTrips: 20,
    progressTrips: 12,
    rewardCents: 5000,
    multiplierBps: 0,
    expiresAt: '2026-06-30T00:00:00.000Z',
    completed: false,
    ...overrides,
  };
}

describe('incentive-progress', () => {
  describe('incentiveProgressFraction / Percent', () => {
    it('calcula la fracción progressTrips/targetTrips acotada a [0,1]', () => {
      expect(incentiveProgressFraction(makeIncentive({progressTrips: 0}))).toBe(0);
      expect(incentiveProgressFraction(makeIncentive({progressTrips: 10, targetTrips: 20}))).toBe(0.5);
      expect(incentiveProgressFraction(makeIncentive({progressTrips: 25, targetTrips: 20}))).toBe(1);
    });

    it('sin meta (targetTrips<=0, p. ej. HORA_PICO) → 0', () => {
      expect(incentiveProgressFraction(makeIncentive({type: 'HORA_PICO', targetTrips: 0}))).toBe(0);
    });

    it('porcentaje entero', () => {
      expect(incentiveProgressPercent(makeIncentive({progressTrips: 12, targetTrips: 20}))).toBe(60);
    });
  });

  describe('incentiveTripsRemaining', () => {
    it('cuenta los viajes que faltan (nunca negativo)', () => {
      expect(incentiveTripsRemaining(makeIncentive({progressTrips: 12, targetTrips: 20}))).toBe(8);
      expect(incentiveTripsRemaining(makeIncentive({progressTrips: 22, targetTrips: 20}))).toBe(0);
      expect(incentiveTripsRemaining(makeIncentive({type: 'HORA_PICO', targetTrips: 0}))).toBe(0);
    });
  });

  describe('formatMultiplier', () => {
    it('convierte bps a bonificación porcentual sobre 1.0', () => {
      expect(formatMultiplier(12000)).toBe('+20%');
      expect(formatMultiplier(15000)).toBe('+50%');
      expect(formatMultiplier(10000)).toBe('+0%');
      expect(formatMultiplier(0)).toBe('');
    });
  });

  describe('isMultiplierIncentive', () => {
    it('solo HORA_PICO usa multiplicador', () => {
      expect(isMultiplierIncentive('HORA_PICO')).toBe(true);
      expect(isMultiplierIncentive('META_VIAJES')).toBe(false);
    });
  });

  describe('isIncentiveExpired / incentiveState', () => {
    it('detecta vencimiento respecto a now', () => {
      expect(isIncentiveExpired(makeIncentive({expiresAt: '2026-05-29T00:00:00.000Z'}), now)).toBe(true);
      expect(isIncentiveExpired(makeIncentive({expiresAt: '2026-06-30T00:00:00.000Z'}), now)).toBe(false);
    });

    it('estado: completado > vencido > activo', () => {
      expect(incentiveState(makeIncentive({completed: true}), now)).toBe('completed');
      expect(incentiveState(makeIncentive({expiresAt: '2026-05-01T00:00:00.000Z'}), now)).toBe('expired');
      expect(incentiveState(makeIncentive(), now)).toBe('active');
    });
  });

  describe('incentiveSortRank', () => {
    it('ordena activos primero, luego completados, vencidos al final', () => {
      const active = makeIncentive();
      const completed = makeIncentive({completed: true});
      const expired = makeIncentive({expiresAt: '2026-05-01T00:00:00.000Z'});
      const sorted = [expired, completed, active]
        .slice()
        .sort((a, b) => incentiveSortRank(a, now) - incentiveSortRank(b, now));
      expect(sorted).toEqual([active, completed, expired]);
    });
  });
});
