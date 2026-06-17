import { describe, it, expect } from 'vitest';
import { FleetDocumentStatus, FleetDocumentType } from '@veo/shared-types';
import {
  buildDriverModelRequest,
  buildDriverProfile,
  buildDriverVehicleFromRest,
  buildDriverVehicleModels,
  buildDriverVehicles,
  REQUIRED_DRIVER_DOCS,
} from './drivers.mapper';
import type {
  AggregateReply,
  DriverDocumentsReply,
  DriverReply,
  UserReply,
  VehicleReply,
} from '../common/grpc-replies';

const driver: DriverReply = {
  id: 'drv-1',
  userId: 'usr-1',
  currentStatus: 'AVAILABLE',
  backgroundCheckStatus: 'APPROVED',
  averageRating: 4.8,
  found: true,
  suspendedAt: '',
  name: 'Khalid Ríos',
  rejectionReason: '',
};

const user: UserReply = {
  id: 'usr-1',
  phone: '+51987654321',
  type: 'driver',
  kycStatus: 'VERIFIED',
  deleted: false,
  found: true,
  name: 'Khalid Ríos',
};

function docsWith(
  types: { type: string; status: string; expiresAt?: string }[],
): DriverDocumentsReply {
  return {
    driverId: 'drv-1',
    documents: types.map((t, i) => ({
      id: `doc-${i}`,
      ownerType: 'DRIVER',
      ownerId: 'drv-1',
      type: t.type,
      documentNumber: 'X',
      status: t.status,
      expiresAt: t.expiresAt ?? '',
    })),
  };
}

const aggregate: AggregateReply = {
  subjectId: 'drv-1',
  role: 'DRIVER',
  rollingAvg30d: 4.7,
  count30d: 30,
  flagged: false,
  flagReason: '',
  lastComputedAt: '2026-05-01T00:00:00.000Z',
  found: true,
};

describe('buildDriverProfile', () => {
  it('marca compliant cuando todos los documentos requeridos están vigentes', () => {
    const docs = docsWith(
      REQUIRED_DRIVER_DOCS.map((type) => ({ type, status: FleetDocumentStatus.VALID })),
    );
    const view = buildDriverProfile(driver, user, aggregate, docs);
    expect(view.compliance.compliant).toBe(true);
    expect(view.compliance.missing).toEqual([]);
    expect(view.documents).toHaveLength(REQUIRED_DRIVER_DOCS.length);
  });

  it('NO es compliant si falta un documento o está vencido', () => {
    const docs = docsWith([
      { type: FleetDocumentType.LICENSE_A1, status: FleetDocumentStatus.VALID },
      { type: FleetDocumentType.SOAT, status: FleetDocumentStatus.EXPIRED },
      { type: FleetDocumentType.PROPERTY_CARD, status: FleetDocumentStatus.VALID },
      // faltan BACKGROUND_CHECK e ITV
    ]);
    const view = buildDriverProfile(driver, user, aggregate, docs);
    expect(view.compliance.compliant).toBe(false);
    expect(view.compliance.missing).toContain(FleetDocumentType.SOAT);
    expect(view.compliance.missing).toContain(FleetDocumentType.BACKGROUND_CHECK);
    expect(view.compliance.missing).toContain(FleetDocumentType.ITV);
  });

  it('considera EXPIRING_SOON como vigente', () => {
    const docs = docsWith(
      REQUIRED_DRIVER_DOCS.map((type) => ({ type, status: FleetDocumentStatus.EXPIRING_SOON })),
    );
    const view = buildDriverProfile(driver, user, aggregate, docs);
    expect(view.compliance.compliant).toBe(true);
    expect(view.documents.every((d) => d.ok)).toBe(true);
  });

  it('rating en null si el agregado no existe; expiresAt vacío → null', () => {
    const docs = docsWith([
      { type: FleetDocumentType.LICENSE_A1, status: FleetDocumentStatus.VALID, expiresAt: '' },
    ]);
    const view = buildDriverProfile(driver, user, { ...aggregate, found: false }, docs);
    expect(view.rating).toBeNull();
    expect(view.documents[0]?.expiresAt).toBeNull();
  });

  it('propaga datos básicos del conductor y del usuario', () => {
    const view = buildDriverProfile(driver, user, aggregate, docsWith([]));
    expect(view.driverId).toBe('drv-1');
    expect(view.userId).toBe('usr-1');
    expect(view.phone).toBe('+51987654321');
    expect(view.kycStatus).toBe('VERIFIED');
    expect(view.averageRating).toBe(4.8);
    expect(view.rating?.count30d).toBe(30);
  });

  it('rejectionReason: wire "" → null (no rechazado); un motivo real se propaga tal cual', () => {
    const sinRechazo = buildDriverProfile(driver, user, aggregate, docsWith([]));
    expect(sinRechazo.rejectionReason).toBeNull();

    const rechazado = buildDriverProfile(
      { ...driver, backgroundCheckStatus: 'REJECTED', rejectionReason: 'Licencia ilegible' },
      user,
      aggregate,
      docsWith([]),
    );
    expect(rechazado.rejectionReason).toBe('Licencia ilegible');
  });
});

describe('mapeo de vehículos del conductor', () => {
  it('buildDriverVehicleFromRest proyecta solo los campos públicos del alta', () => {
    const view = buildDriverVehicleFromRest({
      id: 'veh-1',
      plate: 'ABC-123',
      make: 'Honda',
      model: 'CG 150',
      year: 2021,
      vehicleType: 'MOTO',
      docStatus: 'PENDING',
      status: 'PENDING_REVIEW',
    });
    expect(view).toEqual({
      id: 'veh-1',
      plate: 'ABC-123',
      make: 'Honda',
      model: 'CG 150',
      year: 2021,
      vehicleType: 'MOTO',
      status: 'PENDING_REVIEW',
      docStatus: 'PENDING',
    });
  });

  it('buildDriverVehicles mapea el reply gRPC descartando campos internos (color/active/found)', () => {
    const replies: VehicleReply[] = [
      {
        id: 'veh-1',
        plate: 'ABC-123',
        make: 'Toyota',
        model: 'Yaris',
        year: 2020,
        color: 'Plata',
        vehicleType: 'CAR',
        docStatus: 'VALID',
        status: 'ACTIVE',
        active: true,
        found: true,
      },
    ];
    const views = buildDriverVehicles(replies);
    expect(views).toHaveLength(1);
    expect(views[0]).toEqual({
      id: 'veh-1',
      plate: 'ABC-123',
      make: 'Toyota',
      model: 'Yaris',
      year: 2020,
      vehicleType: 'CAR',
      status: 'ACTIVE',
      docStatus: 'VALID',
    });
    expect(views[0]).not.toHaveProperty('color');
    expect(views[0]).not.toHaveProperty('active');
  });

  it('buildDriverVehicles devuelve [] si no hay vehículos', () => {
    expect(buildDriverVehicles([])).toEqual([]);
  });
});

describe('catálogo de modelos (B5-2 · selector del onboarding)', () => {
  it('buildDriverVehicleModels mapea la página de fleet al view del selector', () => {
    const views = buildDriverVehicleModels({
      items: [
        {
          id: 'm1',
          make: 'Toyota',
          model: 'Yaris',
          yearFrom: 2017,
          yearTo: 2024,
          vehicleType: 'CAR',
          seats: 5,
        },
      ],
      nextCursor: null,
    });
    expect(views).toEqual([
      {
        id: 'm1',
        make: 'Toyota',
        model: 'Yaris',
        yearFrom: 2017,
        yearTo: 2024,
        vehicleType: 'CAR',
        seats: 5,
      },
    ]);
  });

  it('buildDriverVehicleModels tolera items ausente → []', () => {
    expect(buildDriverVehicleModels({ items: undefined as never, nextCursor: null })).toEqual([]);
  });

  it('buildDriverModelRequest proyecta la confirmación mínima de la solicitud', () => {
    const view = buildDriverModelRequest({
      id: 'req-1',
      make: 'Toyota',
      model: 'Probox',
      status: 'PENDING_REVIEW',
    });
    expect(view).toEqual({
      id: 'req-1',
      make: 'Toyota',
      model: 'Probox',
      status: 'PENDING_REVIEW',
    });
  });
});
