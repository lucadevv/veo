/**
 * ADR 013 §2 — specs del resolver PURO de la oferta del viaje (precedencia category > vehicleType >
 * default económico). Los caminos infelices del ADR, uno por uno.
 */
import { describe, it, expect } from 'vitest';
import { OFFERINGS, OfferingId, VehicleClass } from '@veo/shared-types';
import { resolveTripOffering } from './offering';
import { UnknownOfferingError } from '../trips.errors';

describe('resolveTripOffering · precedencia ADR 013 §2', () => {
  it('category presente y conocida → esa oferta (la category manda sobre vehicleType)', () => {
    const { offering, mismatch } = resolveTripOffering(OfferingId.VEO_CONFORT, VehicleClass.CAR);
    expect(offering).toBe(OFFERINGS[OfferingId.VEO_CONFORT]);
    expect(mismatch).toBe(false);
  });

  it('category DESCONOCIDA → 400 UNKNOWN_OFFERING tipado (jamás default silencioso a económico)', () => {
    expect(() => resolveTripOffering('veo_fantasma', undefined)).toThrowError(UnknownOfferingError);
    try {
      resolveTripOffering('veo_fantasma', undefined);
    } catch (err) {
      expect(err).toMatchObject({ code: 'UNKNOWN_OFFERING', httpStatus: 400, details: { category: 'veo_fantasma' } });
    }
  });

  it('category hostil (__proto__) → UNKNOWN_OFFERING (findOffering no resuelve keys del prototype)', () => {
    expect(() => resolveTripOffering('__proto__', undefined)).toThrowError(UnknownOfferingError);
  });

  it('category AUSENTE + vehicleType MOTO (cliente viejo) → veo_moto con SU política de pricing', () => {
    const { offering, mismatch } = resolveTripOffering(undefined, VehicleClass.MOTO);
    expect(offering).toBe(OFFERINGS[OfferingId.VEO_MOTO]);
    expect(offering.pricing).toEqual(OFFERINGS[OfferingId.VEO_MOTO].pricing); // moto deja de heredar ×1.0
    expect(mismatch).toBe(false);
  });

  it('category AUSENTE + vehicleType CAR → veo_economico', () => {
    const { offering } = resolveTripOffering(null, VehicleClass.CAR);
    expect(offering).toBe(OFFERINGS[OfferingId.VEO_ECONOMICO]);
  });

  it('category y vehicleType AUSENTES → default veo_economico (compat total)', () => {
    const { offering, mismatch } = resolveTripOffering(undefined, undefined);
    expect(offering).toBe(OFFERINGS[OfferingId.VEO_ECONOMICO]);
    expect(mismatch).toBe(false);
  });

  it('INCONSISTENCIA veo_moto + CAR → gana la oferta (pool MOTO) y mismatch=true (warn del caller)', () => {
    const { offering, mismatch } = resolveTripOffering(OfferingId.VEO_MOTO, VehicleClass.CAR);
    expect(offering).toBe(OFFERINGS[OfferingId.VEO_MOTO]);
    expect(offering.vehicleClass).toBe(VehicleClass.MOTO); // la oferta es la fuente del pool
    expect(mismatch).toBe(true); // NO 400: apps viejas mandan ambos; un bug de UI no rompe el create
  });

  it('INCONSISTENCIA veo_economico + MOTO → gana la oferta (pool CAR) y mismatch=true', () => {
    const { offering, mismatch } = resolveTripOffering(OfferingId.VEO_ECONOMICO, VehicleClass.MOTO);
    expect(offering).toBe(OFFERINGS[OfferingId.VEO_ECONOMICO]);
    expect(offering.vehicleClass).toBe(VehicleClass.CAR);
    expect(mismatch).toBe(true);
  });
});
