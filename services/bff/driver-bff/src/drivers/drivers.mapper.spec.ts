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
  licenseNumber: '',
  kycStatus: '',
  createdAt: '',
  faceEnrolledAt: '',
  lastVerifiedAt: '',
  phone: '',
  documentId: '',
  birthDate: '',
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
      fileS3Key: '',
      rejectionReason: '',
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
  it('REQUIRED_DRIVER_DOCS = solo los docs que sube el conductor (licencia, SOAT, tarjeta)', () => {
    // BACKGROUND_CHECK (eje identity) e ITV (doc del vehículo) NO son docs del alta del conductor.
    expect(REQUIRED_DRIVER_DOCS).toEqual([
      FleetDocumentType.LICENSE_A1,
      FleetDocumentType.SOAT,
      FleetDocumentType.PROPERTY_CARD,
    ]);
  });

  it('todos los requeridos VALID ⇒ allApproved + compliant, sin faltantes, submittedAllRequired', () => {
    const docs = docsWith(
      REQUIRED_DRIVER_DOCS.map((type) => ({ type, status: FleetDocumentStatus.VALID })),
    );
    const view = buildDriverProfile(driver, user, aggregate, docs);
    expect(view.compliance.allApproved).toBe(true);
    expect(view.compliance.compliant).toBe(true);
    expect(view.compliance.submittedAllRequired).toBe(true);
    expect(view.compliance.missing).toEqual([]);
    expect(view.compliance.rejected).toEqual([]);
    expect(view.documents).toHaveLength(REQUIRED_DRIVER_DOCS.length);
  });

  it('todos los requeridos PENDING_REVIEW ⇒ submittedAllRequired pero NO allApproved, missing vacío', () => {
    // El caso del bug P0: 3 docs PENDING_REVIEW. "Enviado todo" pero "no aprobado" → in_review, no wizard.
    const docs = docsWith(
      REQUIRED_DRIVER_DOCS.map((type) => ({ type, status: FleetDocumentStatus.PENDING_REVIEW })),
    );
    const view = buildDriverProfile(driver, user, aggregate, docs);
    expect(view.compliance.submittedAllRequired).toBe(true);
    expect(view.compliance.allApproved).toBe(false);
    expect(view.compliance.compliant).toBe(false);
    expect(view.compliance.missing).toEqual([]);
    expect(view.compliance.rejected).toEqual([]);
  });

  it('un tipo requerido genuinamente ausente ⇒ aparece en missing y NO submittedAllRequired', () => {
    const docs = docsWith([
      { type: FleetDocumentType.LICENSE_A1, status: FleetDocumentStatus.PENDING_REVIEW },
      { type: FleetDocumentType.SOAT, status: FleetDocumentStatus.PENDING_REVIEW },
      // falta PROPERTY_CARD
    ]);
    const view = buildDriverProfile(driver, user, aggregate, docs);
    expect(view.compliance.submittedAllRequired).toBe(false);
    expect(view.compliance.missing).toEqual([FleetDocumentType.PROPERTY_CARD]);
    expect(view.compliance.allApproved).toBe(false);
  });

  it('un documento requerido REJECTED ⇒ aparece en rejected (sigue presente, no missing)', () => {
    const docs = docsWith([
      { type: FleetDocumentType.LICENSE_A1, status: FleetDocumentStatus.VALID },
      { type: FleetDocumentType.SOAT, status: FleetDocumentStatus.REJECTED },
      { type: FleetDocumentType.PROPERTY_CARD, status: FleetDocumentStatus.VALID },
    ]);
    const view = buildDriverProfile(driver, user, aggregate, docs);
    expect(view.compliance.rejected).toEqual([FleetDocumentType.SOAT]);
    expect(view.compliance.missing).toEqual([]);
    expect(view.compliance.submittedAllRequired).toBe(true);
    expect(view.compliance.allApproved).toBe(false);
  });

  it('considera EXPIRING_SOON como aprobado (vigente)', () => {
    const docs = docsWith(
      REQUIRED_DRIVER_DOCS.map((type) => ({ type, status: FleetDocumentStatus.EXPIRING_SOON })),
    );
    const view = buildDriverProfile(driver, user, aggregate, docs);
    expect(view.compliance.allApproved).toBe(true);
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
