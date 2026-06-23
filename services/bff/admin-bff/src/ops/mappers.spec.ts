import { describe, it, expect } from 'vitest';
import { AdminRole, SuspensionCause } from '@veo/shared-types';
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

  it('driverRecordToApproval: proyecta el enriquecimiento YA redactado (la redacción por rol vive en ops.service)', () => {
    const rec: DriverRecord = {
      id: 'd1',
      userId: 'u1',
      status: 'PENDING',
      averageRating: null,
      backgroundCheckStatus: 'PENDING',
      rejectionReason: null,
      updatedAt: '2026-05-29T00:00:00.000Z',
    };
    // El `enrichment` llega PRE-redactado: ops.service.listDrivers pone fullName/phone a null para sub-Compliance
    // ANTES de pasarlo. El mapper solo proyecta lo que recibe (no decide redacción).
    const visible = {
      fullName: 'Luis Conductor',
      phone: '+51987654321',
      suspendedAt: null,
      suspensionCauses: [],
    };
    const redacted = {
      fullName: null,
      phone: null,
      suspendedAt: null,
      suspensionCauses: [],
    };
    // SIN enriquecimiento (página vacía / sin reply) → null honesto.
    expect(driverRecordToApproval(rec, COMPLIANCE).fullName).toBeNull();
    // CON enriquecimiento visible: se proyecta tal cual.
    expect(driverRecordToApproval(rec, COMPLIANCE, visible).fullName).toBe('Luis Conductor');
    expect(driverRecordToApproval(rec, COMPLIANCE, visible).phone).toBe('+51987654321');
    // Enriquecimiento ya redactado (lo que ops.service arma para sub-Compliance) → null.
    expect(driverRecordToApproval(rec, SUPPORT, redacted).fullName).toBeNull();
    expect(driverRecordToApproval(rec, SUPPORT, redacted).phone).toBeNull();
  });

  describe('driverRecordToApproval · reconciliación del badge de suspensión (autoridad: identity)', () => {
    const base: DriverRecord = {
      id: 'd1',
      userId: 'u1',
      status: 'SUSPENDED',
      averageRating: null,
      backgroundCheckStatus: 'CLEARED',
      rejectionReason: null,
      updatedAt: '2026-05-29T00:00:00.000Z',
    };
    const enrich = (suspendedAt: string | null) => ({
      fullName: null,
      phone: null,
      suspendedAt,
      suspensionCauses: [],
    });

    it('read-model SUSPENDED pero identity LIBRE (auto-reactivación) → badge ACTIVE', () => {
      // El conductor regularizó su documento/ITV: identity quitó el hold (suspendedAt null) SIN emitir
      // driver.reactivated → el read-model quedó stale en SUSPENDED. La reconciliación lo baja a ACTIVE.
      expect(driverRecordToApproval(base, COMPLIANCE, enrich(null)).status).toBe('ACTIVE');
    });

    it('read-model ACTIVE pero identity SUSPENDIDO (ITV por userId, no proyectada) → badge SUSPENDED', () => {
      const active = { ...base, status: 'ACTIVE' };
      expect(
        driverRecordToApproval(active, COMPLIANCE, enrich('2026-06-02T08:00:00.000Z')).status,
      ).toBe('SUSPENDED');
    });

    it('NO toca PENDING/REJECTED aunque identity diga libre (solo cruza SUSPENDED↔ACTIVE)', () => {
      const pending = { ...base, status: 'PENDING' };
      const rejected = { ...base, status: 'REJECTED' };
      expect(driverRecordToApproval(pending, COMPLIANCE, enrich(null)).status).toBe('PENDING');
      expect(driverRecordToApproval(rejected, COMPLIANCE, enrich(null)).status).toBe('REJECTED');
    });

    it('SIN enriquecimiento (página vacía / sin reply) → conserva el status del read-model (degradación honesta)', () => {
      expect(driverRecordToApproval(base, COMPLIANCE).status).toBe('SUSPENDED');
    });

    it('identity confirma SUSPENDED → se mantiene SUSPENDED (idempotente)', () => {
      expect(
        driverRecordToApproval(base, COMPLIANCE, enrich('2026-06-02T08:00:00.000Z')).status,
      ).toBe('SUSPENDED');
    });
  });

  describe('driverRecordToApproval · CAUSAS de suspensión en la lista (FIX 2 · UI cause-aware)', () => {
    const base: DriverRecord = {
      id: 'd1',
      userId: 'u1',
      status: 'SUSPENDED',
      averageRating: null,
      backgroundCheckStatus: 'CLEARED',
      rejectionReason: null,
      updatedAt: '2026-05-29T00:00:00.000Z',
    };

    it('proyecta las causas del enriquecimiento (autoridad: identity) a la fila de la lista', () => {
      const enrichment = {
        fullName: null,
        phone: null,
        suspendedAt: '2026-06-02T08:00:00.000Z',
        suspensionCauses: [SuspensionCause.DOCUMENT_EXPIRED, SuspensionCause.DISCIPLINARY],
      };
      expect(driverRecordToApproval(base, COMPLIANCE, enrichment).suspensionCauses).toEqual([
        SuspensionCause.DOCUMENT_EXPIRED,
        SuspensionCause.DISCIPLINARY,
      ]);
    });

    it('SIN enriquecimiento (página vacía) → [] honesto (nunca se inventa una causa)', () => {
      expect(driverRecordToApproval(base, COMPLIANCE).suspensionCauses).toEqual([]);
    });
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
