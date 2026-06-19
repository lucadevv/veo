import { describe, it, expect } from 'vitest';
import { AdminRole } from '@veo/shared-types';
import {
  tripRecordToSummary,
  driverRecordToSummary,
  driverRecordToApproval,
  mapTripStatus,
} from './mappers';
import type { TripRecord, DriverRecord } from '../read-model/read-model.service';

const COMPLIANCE: AdminRole[] = [AdminRole.COMPLIANCE_SUPERVISOR];
const SUPPORT: AdminRole[] = [AdminRole.SUPPORT_L1];

describe('mappers OPS', () => {
  it('mapea TripRecord → tripSummary preservando céntimos e id', () => {
    const rec: TripRecord = {
      id: 't1',
      status: 'IN_PROGRESS',
      passengerId: 'p1',
      driverId: 'd1',
      fareCents: 1500,
      createdAt: '2026-05-29T00:00:00.000Z',
    };
    // fareCents (monto) hoy NO se redacta: el contrato lo declara number no-nullable → diferido.
    expect(tripRecordToSummary(rec, SUPPORT)).toEqual({
      id: 't1',
      status: 'IN_PROGRESS',
      passengerId: 'p1',
      driverId: 'd1',
      fareCents: 1500,
      createdAt: '2026-05-29T00:00:00.000Z',
    });
  });

  it('driverRecordToApproval: identidad enriquecida y redactada por rol (Compliance ve, sub-Compliance null)', () => {
    const rec: DriverRecord = {
      id: 'd1',
      userId: 'u1',
      status: 'PENDING',
      averageRating: null,
      backgroundCheckStatus: 'PENDING',
      rejectionReason: null,
      updatedAt: '2026-05-29T00:00:00.000Z',
    };
    const identity = { fullName: 'Luis Conductor', phone: '+51987654321' };
    // SIN enriquecimiento (no se pasó identity) → null honesto, aunque el rol pueda verla.
    expect(driverRecordToApproval(rec, COMPLIANCE).fullName).toBeNull();
    // CON enriquecimiento: Compliance VE el nombre/teléfono…
    expect(driverRecordToApproval(rec, COMPLIANCE, identity).fullName).toBe('Luis Conductor');
    expect(driverRecordToApproval(rec, COMPLIANCE, identity).phone).toBe('+51987654321');
    // …pero sub-Compliance (SUPPORT) sigue viendo null aunque la data esté presente (redacción server-side).
    expect(driverRecordToApproval(rec, SUPPORT, identity).fullName).toBeNull();
    expect(driverRecordToApproval(rec, SUPPORT, identity).phone).toBeNull();
  });

  it('mapea DriverRecord → driverSummary con rating nullable', () => {
    const rec: DriverRecord = {
      id: 'd1',
      userId: 'u1',
      status: 'ACTIVE',
      averageRating: null,
      backgroundCheckStatus: 'CLEARED',
      rejectionReason: null,
      updatedAt: '2026-05-29T00:00:00.000Z',
    };
    expect(driverRecordToSummary(rec)).toEqual({
      id: 'd1',
      userId: 'u1',
      status: 'ACTIVE',
      averageRating: null,
      backgroundCheckStatus: 'CLEARED',
    });
  });

  // Cambio de spec JUSTIFICADO (auditoría, lote P): el mapper anterior DISFRAZABA estados —
  // REASSIGNING (pasajero abandonado, ops debe intervenir) y todo lo desconocido caían en
  // REQUESTED; EXPIRED/FAILED se colapsaban en CANCELLED. El contrato admin ya expresa esos
  // estados: la vista ahora es honesta (identidad + alias CANCELLED_BY_* + UNKNOWN explícito).
  it('normaliza estados de trip-service al enum de la vista (honesto, sin default mudo)', () => {
    expect(mapTripStatus('IN_PROGRESS')).toBe('IN_PROGRESS');
    expect(mapTripStatus('CANCELLED_BY_PASSENGER')).toBe('CANCELLED');
    expect(mapTripStatus('CANCELLED_BY_DRIVER')).toBe('CANCELLED');
    expect(mapTripStatus('SCHEDULED')).toBe('SCHEDULED');
    expect(mapTripStatus('REASSIGNING')).toBe('REASSIGNING');
    expect(mapTripStatus('EXPIRED')).toBe('EXPIRED');
    expect(mapTripStatus('FAILED')).toBe('FAILED');
    expect(mapTripStatus('ALGO_RARO')).toBe('UNKNOWN');
  });
});
