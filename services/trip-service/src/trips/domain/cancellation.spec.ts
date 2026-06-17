import { describe, it, expect } from 'vitest';
import { calculateCancellationPenalty, CANCELLATION_PENALTY_CENTS } from './cancellation';

const base = new Date('2026-05-28T12:00:00.000Z');
const minutes = (n: number) => new Date(base.getTime() + n * 60_000);

describe('BR-T03 · penalización de cancelación', () => {
  it('sin conductor asignado (REQUESTED) → gratis', () => {
    const penalty = calculateCancellationPenalty({
      by: 'PASSENGER',
      assignedAt: null,
      driverEta: null,
      now: base,
    });
    expect(penalty).toBe(0);
  });

  it('pasajero cancela < 2 min desde la asignación → gratis', () => {
    const penalty = calculateCancellationPenalty({
      by: 'PASSENGER',
      assignedAt: base,
      driverEta: minutes(8),
      now: minutes(1.5),
    });
    expect(penalty).toBe(0);
  });

  it('pasajero cancela ≥ 2 min y conductor puntual → penalización S/3', () => {
    const penalty = calculateCancellationPenalty({
      by: 'PASSENGER',
      assignedAt: base,
      driverEta: minutes(8),
      now: minutes(3),
    });
    expect(penalty).toBe(CANCELLATION_PENALTY_CENTS);
  });

  it('conductor con > 5 min de retraso respecto a su ETA → gratis', () => {
    const penalty = calculateCancellationPenalty({
      by: 'PASSENGER',
      assignedAt: base,
      driverEta: minutes(5),
      now: minutes(11), // 6 min después de la ETA
    });
    expect(penalty).toBe(0);
  });

  it('conductor con retraso de exactamente 5 min (no > 5) → penaliza', () => {
    const penalty = calculateCancellationPenalty({
      by: 'PASSENGER',
      assignedAt: base,
      driverEta: minutes(5),
      now: minutes(10), // exactamente 5 min de retraso
    });
    expect(penalty).toBe(CANCELLATION_PENALTY_CENTS);
  });

  it('cancelación del conductor → el pasajero no paga', () => {
    const penalty = calculateCancellationPenalty({
      by: 'DRIVER',
      assignedAt: base,
      driverEta: minutes(8),
      now: minutes(10),
    });
    expect(penalty).toBe(0);
  });

  it('cancelación del sistema → sin penalización al pasajero', () => {
    const penalty = calculateCancellationPenalty({
      by: 'SYSTEM',
      assignedAt: base,
      driverEta: minutes(8),
      now: minutes(10),
    });
    expect(penalty).toBe(0);
  });
});
