import { describe, it, expect } from 'vitest';
import { ValidationError } from '@veo/utils';
import {
  assertScheduleWindow,
  isDueForActivation,
  MIN_LEAD_MS,
  MAX_HORIZON_MS,
  ACTIVATION_LEAD_MS,
} from './scheduling';

const now = new Date('2026-06-01T12:00:00.000Z');

describe('Ola 2B · ventana de viaje programado (assertScheduleWindow)', () => {
  it('acepta una hora dentro de [15min, 7días]', () => {
    const at = new Date(now.getTime() + 60 * 60 * 1000); // +1h
    expect(assertScheduleWindow(at, now)).toEqual(at);
  });

  it('rechaza el pasado', () => {
    const at = new Date(now.getTime() - 60 * 1000);
    expect(() => assertScheduleWindow(at, now)).toThrow(ValidationError);
  });

  it('rechaza menos de 15 min de antelación', () => {
    const at = new Date(now.getTime() + MIN_LEAD_MS - 1000);
    expect(() => assertScheduleWindow(at, now)).toThrow(ValidationError);
  });

  it('acepta exactamente 15 min de antelación', () => {
    const at = new Date(now.getTime() + MIN_LEAD_MS);
    expect(assertScheduleWindow(at, now)).toEqual(at);
  });

  it('rechaza más de 7 días', () => {
    const at = new Date(now.getTime() + MAX_HORIZON_MS + 1000);
    expect(() => assertScheduleWindow(at, now)).toThrow(ValidationError);
  });
});

describe('Ola 2B · activación por lead time (isDueForActivation)', () => {
  it('aún no vence si falta más que el lead time', () => {
    const at = new Date(now.getTime() + ACTIVATION_LEAD_MS + 60 * 1000);
    expect(isDueForActivation(at, now)).toBe(false);
  });

  it('vence cuando falta el lead time o menos', () => {
    const at = new Date(now.getTime() + ACTIVATION_LEAD_MS - 1000);
    expect(isDueForActivation(at, now)).toBe(true);
  });
});
