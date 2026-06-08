/** Tests del agregador puro de la vista de seguimiento familiar. */
import { describe, it, expect } from 'vitest';
import { familyTrackingView } from '@veo/api-client';
import {
  assembleFamilyView,
  assembleMaskedPanicView,
  buildFamilyDriver,
  isPanicActive,
  safeTripStatus,
} from './family-view';
import type { AggregateReply, DriverReply, VehicleReply } from '../infra/grpc-types';

const driver: DriverReply = {
  id: 'drv-1',
  userId: 'usr-1',
  currentStatus: 'ON_TRIP',
  backgroundCheckStatus: 'APPROVED',
  averageRating: 4.0,
  found: true,
  name: 'Khalid Ríos',
};
const aggregate: AggregateReply = {
  subjectId: 'drv-1',
  role: 'DRIVER',
  rollingAvg30d: 4.9,
  count30d: 10,
  flagged: false,
  flagReason: '',
  lastComputedAt: '2026-05-01T00:00:00.000Z',
  found: true,
};
const vehicle: VehicleReply = {
  id: 'veh-1',
  plate: 'XYZ-987',
  make: 'Kia',
  model: 'Rio',
  year: 2022,
  color: 'Gris',
  docStatus: 'OK',
  active: true,
  found: true,
};

describe('safeTripStatus', () => {
  it('toma el primer candidato válido', () => {
    expect(safeTripStatus('UNKNOWN', 'ARRIVING')).toBe('ARRIVING');
  });
  it('cae a REQUESTED si no hay candidatos válidos', () => {
    expect(safeTripStatus(null, undefined, 'WAT')).toBe('REQUESTED');
  });
});

describe('isPanicActive (seguridad-crítica · pánico oculto)', () => {
  it('detecta PANIC en cualquier candidato', () => {
    expect(isPanicActive('IN_PROGRESS', 'PANIC')).toBe(true);
    expect(isPanicActive('PANIC')).toBe(true);
  });
  it('es case/space-insensitive (fail-safe = ocultar)', () => {
    expect(isPanicActive(' panic ')).toBe(true);
    expect(isPanicActive('Panic')).toBe(true);
  });
  it('false para estados normales o vacíos', () => {
    expect(isPanicActive('IN_PROGRESS', 'COMPLETED')).toBe(false);
    expect(isPanicActive(null, undefined, '')).toBe(false);
  });
});

describe('assembleMaskedPanicView (seguridad-crítica · pánico oculto)', () => {
  it('devuelve un estado benigno TERMINADO sin datos en vivo', () => {
    const view = assembleMaskedPanicView('trip-9', '2026-05-29T12:00:00.000Z');
    expect(() => familyTrackingView.parse(view)).not.toThrow();
    expect(view.status).toBe('COMPLETED');
    expect(view.driverLocation).toBeNull();
    expect(view.driver).toBeNull();
    expect(view.origin).toBeNull();
    expect(view.destination).toBeNull();
    expect(view.etaSeconds).toBeNull();
    expect(view.routePolyline).toBeNull();
    // No se revela el corte del enlace: se ve como un viaje normal finalizado.
    expect(view.revoked).toBe(false);
    expect(view.tripId).toBe('trip-9');
  });
  it('nunca filtra el estado PANIC crudo', () => {
    const view = assembleMaskedPanicView('trip-9', '2026-05-29T12:00:00.000Z');
    expect(view.status).not.toBe('PANIC');
  });
});

describe('buildFamilyDriver', () => {
  it('arma el conductor con rating 30d y datos del vehículo (sin PII en name)', () => {
    const fam = buildFamilyDriver(driver, aggregate, vehicle);
    expect(fam).toEqual({
      name: '',
      rating: 4.9,
      vehiclePlate: 'XYZ-987',
      vehicleModel: 'Kia Rio',
      vehicleColor: 'Gris',
    });
  });
  it('null cuando no hay conductor ni vehículo', () => {
    expect(buildFamilyDriver(null, null, null)).toBeNull();
  });
});

describe('assembleFamilyView', () => {
  it('produce una vista válida contra el contrato familyTrackingView', () => {
    const view = assembleFamilyView({
      tripId: 'trip-1',
      status: 'IN_PROGRESS',
      origin: { lat: -12.04, lon: -77.04 },
      destination: { lat: -12.1, lon: -77.0 },
      driverLocation: { lat: -12.05, lon: -77.03 },
      driver: buildFamilyDriver(driver, aggregate, vehicle),
      etaSeconds: 540,
      routePolyline: 'abc123',
      expiresAt: '2026-05-29T12:00:00.000Z',
      revoked: false,
    });
    expect(() => familyTrackingView.parse(view)).not.toThrow();
    expect(view.etaSeconds).toBe(540);
    expect(view.revoked).toBe(false);
  });
});
