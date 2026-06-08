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
    const thresholds = { driverReview: 4.8, driverSuspension: 4.5, passengerReverify: 4.5 };
    expect(evaluateFlag('DRIVER', 4.7, 5, thresholds)).toEqual({ flagged: true, reason: 'review' });
  });
});
