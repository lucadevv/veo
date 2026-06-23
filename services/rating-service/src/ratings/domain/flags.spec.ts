import { describe, it, expect } from 'vitest';
import { evaluateDriverFlag, evaluatePassengerFlag, evaluateFlag } from './flags';

describe('evaluateDriverFlag · BR-D01 (fronteras 4.3 y 4.0)', () => {
  it('avg 4.3 exacto → SIN flag (umbral estricto <)', () => {
    expect(evaluateDriverFlag(4.3, 10)).toEqual({ flagged: false, reason: null });
  });

  it('avg 4.29 → review', () => {
    expect(evaluateDriverFlag(4.29, 10)).toEqual({ flagged: true, reason: 'review' });
  });

  it('avg 4.0 exacto → review (4.0 < 4.3 pero no < 4.0)', () => {
    expect(evaluateDriverFlag(4.0, 10)).toEqual({ flagged: true, reason: 'review' });
  });

  it('avg 3.99 → suspension', () => {
    expect(evaluateDriverFlag(3.99, 10)).toEqual({ flagged: true, reason: 'suspension' });
  });

  it('avg 5.0 → sin flag', () => {
    expect(evaluateDriverFlag(5, 10)).toEqual({ flagged: false, reason: null });
  });

  it('count 0 → nunca se marca, aunque avg sea bajo', () => {
    expect(evaluateDriverFlag(0, 0)).toEqual({ flagged: false, reason: null });
  });
});

describe('evaluatePassengerFlag · BR-I05 (frontera 4.0)', () => {
  it('avg 4.0 exacto → sin flag', () => {
    expect(evaluatePassengerFlag(4.0, 10)).toEqual({ flagged: false, reason: null });
  });

  it('avg 3.99 → reverification', () => {
    expect(evaluatePassengerFlag(3.99, 10)).toEqual({ flagged: true, reason: 'reverification' });
  });

  it('count 0 → sin flag', () => {
    expect(evaluatePassengerFlag(1, 0)).toEqual({ flagged: false, reason: null });
  });
});

describe('evaluateFlag · despacho por rol', () => {
  it('DRIVER usa umbrales de conductor', () => {
    expect(evaluateFlag('DRIVER', 4.2, 5)).toEqual({ flagged: true, reason: 'review' });
  });

  it('PASSENGER usa umbral de pasajero (4.2 no marca)', () => {
    expect(evaluateFlag('PASSENGER', 4.2, 5)).toEqual({ flagged: false, reason: null });
  });

  it('respeta umbrales custom', () => {
    const thresholds = {
      driverReview: 4.8,
      driverSuspension: 4.5,
      driverMinReviewsForSuspension: 10,
      passengerReverify: 4.5,
    };
    expect(evaluateFlag('DRIVER', 4.7, 5, thresholds)).toEqual({ flagged: true, reason: 'review' });
  });
});

describe('evaluateDriverFlag · MÍNIMO de reseñas para suspensión (auto-suspensión por rating bajo)', () => {
  // Default driverMinReviewsForSuspension = 10.
  it('avg < 4.0 con count = mínimo exacto (10) → suspension (≥ es la frontera)', () => {
    expect(evaluateDriverFlag(3.0, 10)).toEqual({ flagged: true, reason: 'suspension' });
  });

  it('avg < 4.0 con count por encima del mínimo (25) → suspension', () => {
    expect(evaluateDriverFlag(2.5, 25)).toEqual({ flagged: true, reason: 'suspension' });
  });

  it('avg < 4.0 con count JUSTO debajo del mínimo (9) → CAPA en review (NO suspende)', () => {
    expect(evaluateDriverFlag(3.0, 9)).toEqual({ flagged: true, reason: 'review' });
  });

  it('avg < 4.0 con 1 sola reseña → review (no se castiga por 1 reseña mala)', () => {
    expect(evaluateDriverFlag(1.0, 1)).toEqual({ flagged: true, reason: 'review' });
  });

  it('avg en banda review (4.2) con count alto → review (el mínimo no aplica a la banda review)', () => {
    expect(evaluateDriverFlag(4.2, 50)).toEqual({ flagged: true, reason: 'review' });
  });

  it('respeta un mínimo custom: min=3 → con count=3 y avg<4.0 suspende; con count=2 capa en review', () => {
    const thresholds = {
      driverReview: 4.3,
      driverSuspension: 4.0,
      driverMinReviewsForSuspension: 3,
      passengerReverify: 4.0,
    };
    expect(evaluateDriverFlag(3.0, 3, thresholds)).toEqual({ flagged: true, reason: 'suspension' });
    expect(evaluateDriverFlag(3.0, 2, thresholds)).toEqual({ flagged: true, reason: 'review' });
  });
});
