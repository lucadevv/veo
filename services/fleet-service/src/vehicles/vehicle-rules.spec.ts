import { describe, it, expect } from 'vitest';
import { FleetDocumentStatus, FleetDocumentType } from '@veo/shared-types';
import { VehicleDocStatus } from '../generated/prisma';
import {
  isVehicleYearEligible,
  aggregateVehicleDocStatus,
  deriveVehicleReviewStatus,
  hasRequiredVehicleDocsOperable,
  pickActiveVehicle,
  VehicleReviewStatus,
} from './vehicle-rules';

describe('pickActiveVehicle (vehículo activo server-authoritative)', () => {
  const v = (
    id: string,
    docStatus: VehicleDocStatus,
    selectedAt: Date | null,
    createdAt: Date,
  ) => ({
    id,
    docStatus,
    selectedAt,
    createdAt,
  });

  it('elige el de selectedAt más reciente entre los operables', () => {
    const a = v('a', VehicleDocStatus.VALID, new Date('2026-06-01'), new Date('2026-01-01'));
    const b = v('b', VehicleDocStatus.VALID, new Date('2026-06-09'), new Date('2026-02-01'));
    expect(pickActiveVehicle([a, b])?.id).toBe('b');
  });

  it('si ninguno fue seleccionado, cae al más recientemente registrado', () => {
    const a = v('a', VehicleDocStatus.VALID, null, new Date('2026-01-01'));
    const b = v('b', VehicleDocStatus.VALID, null, new Date('2026-03-01'));
    expect(pickActiveVehicle([a, b])?.id).toBe('b');
  });

  it('excluye vehículos con docs VENCIDOS (EXPIRED)', () => {
    const expired = v(
      'a',
      VehicleDocStatus.EXPIRED,
      new Date('2026-06-09'),
      new Date('2026-05-01'),
    );
    const valid = v('b', VehicleDocStatus.VALID, null, new Date('2026-01-01'));
    expect(pickActiveVehicle([expired, valid])?.id).toBe('b');
  });

  it('EXPIRING_SOON sigue siendo operable', () => {
    const soon = v(
      'a',
      VehicleDocStatus.EXPIRING_SOON,
      new Date('2026-06-09'),
      new Date('2026-05-01'),
    );
    expect(pickActiveVehicle([soon])?.id).toBe('a');
  });

  it('null si no hay ninguno operable (todos vencidos o lista vacía)', () => {
    expect(pickActiveVehicle([])).toBeNull();
    const expired = v('a', VehicleDocStatus.EXPIRED, null, new Date('2026-01-01'));
    expect(pickActiveVehicle([expired])).toBeNull();
  });
});

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
    expect(aggregateVehicleDocStatus(['VALID', 'EXPIRING_SOON', 'EXPIRED'])).toBe(
      VehicleDocStatus.EXPIRED,
    );
  });

  it('EXPIRING_SOON si no hay vencidos pero sí próximos', () => {
    expect(aggregateVehicleDocStatus(['VALID', 'EXPIRING_SOON'])).toBe(
      VehicleDocStatus.EXPIRING_SOON,
    );
  });

  it('todos válidos → VALID', () => {
    expect(aggregateVehicleDocStatus(['VALID', 'VALID'])).toBe(VehicleDocStatus.VALID);
  });
});

describe('hasRequiredVehicleDocsOperable (SOAT+ITV presentes+aprobados+vigentes)', () => {
  const doc = (type: FleetDocumentType, status: FleetDocumentStatus) => ({ type, status });

  it('SOAT VALID + ITV VALID → true (ambos requeridos operables)', () => {
    expect(
      hasRequiredVehicleDocsOperable([
        doc(FleetDocumentType.SOAT, FleetDocumentStatus.VALID),
        doc(FleetDocumentType.ITV, FleetDocumentStatus.VALID),
      ]),
    ).toBe(true);
  });

  it('ambos EXPIRING_SOON → true (no vencidos sigue siendo operable)', () => {
    expect(
      hasRequiredVehicleDocsOperable([
        doc(FleetDocumentType.SOAT, FleetDocumentStatus.EXPIRING_SOON),
        doc(FleetDocumentType.ITV, FleetDocumentStatus.EXPIRING_SOON),
      ]),
    ).toBe(true);
  });

  it('SOAT VALID + ITV AUSENTE → false (falta un tipo requerido)', () => {
    expect(
      hasRequiredVehicleDocsOperable([doc(FleetDocumentType.SOAT, FleetDocumentStatus.VALID)]),
    ).toBe(false);
  });

  it('SOAT VALID + ITV PENDING_REVIEW (sin aprobar) → false', () => {
    expect(
      hasRequiredVehicleDocsOperable([
        doc(FleetDocumentType.SOAT, FleetDocumentStatus.VALID),
        doc(FleetDocumentType.ITV, FleetDocumentStatus.PENDING_REVIEW),
      ]),
    ).toBe(false);
  });

  it('SOAT VALID + ITV EXPIRED (vencido) → false', () => {
    expect(
      hasRequiredVehicleDocsOperable([
        doc(FleetDocumentType.SOAT, FleetDocumentStatus.VALID),
        doc(FleetDocumentType.ITV, FleetDocumentStatus.EXPIRED),
      ]),
    ).toBe(false);
  });

  it('sin documentos → false (un vehículo sin SOAT/ITV no puede operar)', () => {
    expect(hasRequiredVehicleDocsOperable([])).toBe(false);
  });
});

describe('deriveVehicleReviewStatus (operabilidad derivada de señales reales)', () => {
  it('docs operables + ficha linkeada → ACTIVE (operable)', () => {
    expect(
      deriveVehicleReviewStatus({ docsOperable: true, modelSpecId: 'spec-1' }),
    ).toBe(VehicleReviewStatus.ACTIVE);
  });

  it('docs NO operables → PENDING_REVIEW aunque tenga ficha', () => {
    expect(
      deriveVehicleReviewStatus({ docsOperable: false, modelSpecId: 'spec-1' }),
    ).toBe(VehicleReviewStatus.PENDING_REVIEW);
  });

  it('SIN ficha linkeada (modelSpecId null) → PENDING_REVIEW aunque los docs estén operables', () => {
    expect(
      deriveVehicleReviewStatus({ docsOperable: true, modelSpecId: null }),
    ).toBe(VehicleReviewStatus.PENDING_REVIEW);
  });

  it('ni docs operables ni ficha → PENDING_REVIEW', () => {
    expect(
      deriveVehicleReviewStatus({ docsOperable: false, modelSpecId: null }),
    ).toBe(VehicleReviewStatus.PENDING_REVIEW);
  });
});
