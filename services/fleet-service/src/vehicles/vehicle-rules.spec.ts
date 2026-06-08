import { describe, it, expect } from 'vitest';
import { VehicleDocStatus } from '../generated/prisma';
import {
  isVehicleYearEligible,
  aggregateVehicleDocStatus,
  deriveVehicleReviewStatus,
  VehicleReviewStatus,
} from './vehicle-rules';

describe('isVehicleYearEligible (BR-D04 — año >= 2017)', () => {
  it('acepta 2017 y posteriores', () => {
    expect(isVehicleYearEligible(2017)).toBe(true);
    expect(isVehicleYearEligible(2020)).toBe(true);
  });

  it('rechaza anteriores a 2017', () => {
    expect(isVehicleYearEligible(2016)).toBe(false);
    expect(isVehicleYearEligible(2000)).toBe(false);
  });

  it('respeta un año mínimo configurable', () => {
    expect(isVehicleYearEligible(2018, 2019)).toBe(false);
    expect(isVehicleYearEligible(2019, 2019)).toBe(true);
  });

  it('rechaza años no enteros', () => {
    expect(isVehicleYearEligible(2020.5)).toBe(false);
  });
});

describe('aggregateVehicleDocStatus', () => {
  it('sin documentos → VALID', () => {
    expect(aggregateVehicleDocStatus([])).toBe(VehicleDocStatus.VALID);
  });

  it('toma el peor estado (EXPIRED domina)', () => {
    expect(aggregateVehicleDocStatus(['VALID', 'EXPIRING_SOON', 'EXPIRED'])).toBe(VehicleDocStatus.EXPIRED);
  });

  it('EXPIRING_SOON si no hay vencidos pero sí próximos', () => {
    expect(aggregateVehicleDocStatus(['VALID', 'EXPIRING_SOON'])).toBe(VehicleDocStatus.EXPIRING_SOON);
  });

  it('todos válidos → VALID', () => {
    expect(aggregateVehicleDocStatus(['VALID', 'VALID'])).toBe(VehicleDocStatus.VALID);
  });
});

describe('deriveVehicleReviewStatus (onboarding self-service)', () => {
  it('vehículo inactivo → PENDING_REVIEW', () => {
    expect(deriveVehicleReviewStatus({ active: false })).toBe(VehicleReviewStatus.PENDING_REVIEW);
  });

  it('vehículo activo → ACTIVE', () => {
    expect(deriveVehicleReviewStatus({ active: true })).toBe(VehicleReviewStatus.ACTIVE);
  });
});
