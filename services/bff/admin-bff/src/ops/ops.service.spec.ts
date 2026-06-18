import { describe, it, expect, vi } from 'vitest';
import { OpsService } from './ops.service';
import type { GrpcServiceClient, InternalRestClient } from '@veo/rpc';
import type { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '@veo/auth';
import { ConflictError, ForbiddenError, NotFoundError } from '@veo/utils';
import { AdminRole, FleetDocumentStatus, FleetDocumentType } from '@veo/shared-types';
import type { ReadModelService } from '../read-model/read-model.service';
import type { AuditRecorder } from '../audit/audit-recorder.service';
import type { Env } from '../config/env.schema';

const identity: AuthenticatedUser = {
  userId: 'op1',
  type: 'admin',
  roles: ['ADMIN'],
  sessionId: 's1',
};

function grpc(impl: (method: string, req: Record<string, unknown>) => unknown): GrpcServiceClient {
  return {
    call: vi.fn((method: string, req: Record<string, unknown>) =>
      Promise.resolve(impl(method, req)),
    ),
  } as unknown as GrpcServiceClient;
}

const config = { get: () => 'secret' } as unknown as ConfigService<Env, true>;
const noopAudit = {
  record: vi.fn().mockResolvedValue({ id: 'a', seq: '1', hash: 'h' }),
} as unknown as AuditRecorder;
const noopReadModel = {} as unknown as ReadModelService;
const noopRest = {} as unknown as InternalRestClient;
const noopMedia = {} as unknown as InternalRestClient;
const noopFleet = grpc(() => ({})); // fleet sin vehículos → vehiclePlate null

describe('OpsService.tripDetail (agregador gRPC → contrato PLANO tripDetail)', () => {
  it('aplana al contrato: createdAt←requestedAt, origin/destination de coords, nombres de identity', async () => {
    const tripGrpc = grpc((m) => {
      if (m === 'GetTrip')
        return {
          id: 't1',
          passengerId: 'p1',
          driverId: 'd1',
          vehicleId: 'v1',
          status: 'COMPLETED',
          fareCents: 2500,
          currency: 'PEN',
          distanceMeters: 8000,
          durationSeconds: 1200,
          paymentMethod: 'YAPE',
          childMode: false,
          penaltyCents: 0,
          requestedAt: '2026-06-01T10:00:00.000Z',
          originLat: -12.05,
          originLng: -77.04,
          destinationLat: -12.1,
          destinationLng: -77.0,
          found: true,
        };
      return {};
    });
    const identityGrpc = grpc((m) => {
      if (m === 'GetUser')
        return {
          id: 'p1',
          type: 'passenger',
          kycStatus: 'VERIFIED',
          name: 'Ana Pérez',
          deleted: false,
          found: true,
        };
      if (m === 'GetDriver')
        return {
          id: 'd1',
          userId: 'u-d1',
          currentStatus: 'SUSPENDED',
          backgroundCheckStatus: 'CLEARED',
          averageRating: 4.8,
          name: 'Khalid Ríos',
          suspendedAt: '2026-06-02T08:00:00.000Z',
          found: true,
        };
      return {};
    });

    const fleetGrpc = grpc((m) =>
      m === 'GetDriverVehicles'
        ? { driverId: 'd1', vehicles: [{ id: 'v1', plate: 'ABC-123', active: true, found: true }] }
        : {},
    );
    const svc = new OpsService(
      tripGrpc,
      identityGrpc,
      fleetGrpc,
      noopRest,
      noopMedia,
      noopReadModel,
      noopAudit,
      config,
    );
    const view = await svc.tripDetail(identity, 't1');

    expect(view.status).toBe('COMPLETED');
    expect(view.fareCents).toBe(2500);
    expect(view.createdAt).toBe('2026-06-01T10:00:00.000Z'); // ← requestedAt
    expect(view.origin).toEqual({ lat: -12.05, lon: -77.04 }); // lng→lon
    expect(view.destination).toEqual({ lat: -12.1, lon: -77.0 });
    expect(view.passengerName).toBe('Ana Pérez');
    expect(view.driverName).toBe('Khalid Ríos');
    // El proto manda suspendedAt (identity) y la view del panel YA NO lo pierde (drift cerrado).
    expect(view.driverSuspendedAt).toBe('2026-06-02T08:00:00.000Z');
    expect(view.paymentMethod).toBe('YAPE');
    // Datos EN VIVO / no expuestos por GetTrip → null/[] honesto (no data falsa).
    expect(view.driverLocation).toBeNull();
    expect(view.etaSeconds).toBeNull();
    // vehiclePlate AHORA se enriquece desde fleet (GetDriverVehicles): el ACTIVO.
    expect(view.vehiclePlate).toBe('ABC-123');
    expect(view.timeline).toEqual([]);
  });

  it('SUPPORT_L1 (sub-Compliance): redacta identidad/placa/geo per matriz; fareCents diferido visible', async () => {
    const tripGrpc = grpc((m) =>
      m === 'GetTrip'
        ? {
            id: 't1',
            passengerId: 'p1',
            driverId: 'd1',
            status: 'COMPLETED',
            fareCents: 2500,
            distanceMeters: 8000,
            paymentMethod: 'YAPE',
            requestedAt: '2026-06-01T10:00:00.000Z',
            originLat: -12.054321,
            originLng: -77.041234,
            destinationLat: -12.1,
            destinationLng: -77.0,
            found: true,
          }
        : {},
    );
    const identityGrpc = grpc((m) =>
      m === 'GetUser'
        ? { name: 'Ana Pérez', found: true }
        : m === 'GetDriver'
          ? { name: 'Khalid Ríos', found: true }
          : {},
    );
    const fleetGrpc = grpc((m) =>
      m === 'GetDriverVehicles'
        ? { vehicles: [{ id: 'v1', plate: 'ABC-123', active: true, found: true }] }
        : {},
    );
    const svc = new OpsService(
      tripGrpc,
      identityGrpc,
      fleetGrpc,
      noopRest,
      noopMedia,
      noopReadModel,
      noopAudit,
      config,
    );
    const support: AuthenticatedUser = { ...identity, roles: ['SUPPORT_L1'] };
    const view = await svc.tripDetail(support, 't1');
    // IDENTIDAD → null (Compliance+)
    expect(view.passengerName).toBeNull();
    expect(view.driverName).toBeNull();
    // PLACA → enmascarada '•••' + últimos 3 (SUPPORT no la ve completa)
    expect(view.vehiclePlate).toBe('•••123');
    // GEO → coarse 3 decimales (~100m)
    expect(view.origin).toEqual({ lat: -12.054, lon: -77.041 });
    // MONTO → diferido (contrato no-nullable): sigue visible
    expect(view.fareCents).toBe(2500);
  });

  it('origin 0,0 (sin set) → null honesto', async () => {
    const tripGrpc = grpc((m) =>
      m === 'GetTrip'
        ? {
            id: 't1',
            passengerId: 'p1',
            driverId: '',
            vehicleId: '',
            status: 'REQUESTED',
            fareCents: 0,
            currency: 'PEN',
            distanceMeters: 0,
            durationSeconds: 0,
            paymentMethod: 'CASH',
            childMode: false,
            penaltyCents: 0,
            requestedAt: '2026-06-01T10:00:00.000Z',
            originLat: 0,
            originLng: 0,
            destinationLat: 0,
            destinationLng: 0,
            found: true,
          }
        : {},
    );
    const svc = new OpsService(
      tripGrpc,
      grpc(() => ({})),
      noopFleet,
      noopRest,
      noopMedia,
      noopReadModel,
      noopAudit,
      config,
    );
    const view = await svc.tripDetail(identity, 't1');
    expect(view.origin).toBeNull();
    expect(view.destination).toBeNull();
    expect(view.driverId).toBeNull();
    // Sin conductor asignado → sin fecha de suspensión (null honesto, no '').
    expect(view.driverSuspendedAt).toBeNull();
  });

  it('lanza NotFoundError si el viaje no existe', async () => {
    const tripGrpc = grpc(() => ({ found: false }));
    const svc = new OpsService(
      tripGrpc,
      grpc(() => ({})),
      noopFleet,
      noopRest,
      noopMedia,
      noopReadModel,
      noopAudit,
      config,
    );
    await expect(svc.tripDetail(identity, 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });
});

/** Documento de flota mínimo para los specs del gate de aprobación / detalle. */
function fleetDoc(
  type: FleetDocumentType,
  status: FleetDocumentStatus,
  overrides: Partial<{ id: string; expiresAt: string; rejectionReason: string; fileS3Key: string }> = {},
) {
  return {
    id: overrides.id ?? `doc-${type}`,
    ownerType: 'DRIVER',
    ownerId: 'd1',
    type,
    documentNumber: 'X-123',
    status,
    expiresAt: overrides.expiresAt ?? '',
    fileS3Key: overrides.fileS3Key ?? '',
    rejectionReason: overrides.rejectionReason ?? '',
  };
}

/** Las tres credenciales obligatorias, todas VALID → el gate pasa. */
const allValidDocs = [
  fleetDoc(FleetDocumentType.LICENSE_A1, FleetDocumentStatus.VALID),
  fleetDoc(FleetDocumentType.SOAT, FleetDocumentStatus.VALID),
  fleetDoc(FleetDocumentType.PROPERTY_CARD, FleetDocumentStatus.VALID),
];

describe('OpsService.approveDriver · gate de documentos obligatorios (server-side, autoritativo)', () => {
  it('aprueba vía REST y audita cuando LICENSE_A1+SOAT+PROPERTY_CARD están VALID', async () => {
    const rest = {
      post: vi.fn().mockResolvedValue({ id: 'd1', backgroundCheckStatus: 'CLEARED' }),
    } as unknown as InternalRestClient;
    const audit = {
      record: vi.fn().mockResolvedValue({ id: 'a', seq: '1', hash: 'h' }),
    } as unknown as AuditRecorder;
    const fleetGrpc = grpc((m) =>
      m === 'GetDriverDocuments' ? { driverId: 'd1', documents: allValidDocs } : {},
    );
    const svc = new OpsService(
      grpc(() => ({})),
      grpc(() => ({})),
      fleetGrpc,
      rest,
      noopMedia,
      noopReadModel,
      audit,
      config,
    );
    const out = await svc.approveDriver(identity, 'd1');
    expect(out.backgroundCheckStatus).toBe('CLEARED');
    expect(rest.post).toHaveBeenCalledWith('/drivers/d1/approve', { identity });
    expect(audit.record).toHaveBeenCalledOnce();
  });

  it('lanza ConflictError y NO llama a identity approve cuando falta el SOAT válido', async () => {
    const post = vi.fn();
    const record = vi.fn();
    const rest = { post } as unknown as InternalRestClient;
    const audit = { record } as unknown as AuditRecorder;
    // SOAT presente pero EXPIRED (no VALID) → no satisface el gate.
    const fleetGrpc = grpc((m) =>
      m === 'GetDriverDocuments'
        ? {
            driverId: 'd1',
            documents: [
              fleetDoc(FleetDocumentType.LICENSE_A1, FleetDocumentStatus.VALID),
              fleetDoc(FleetDocumentType.SOAT, FleetDocumentStatus.EXPIRED),
              fleetDoc(FleetDocumentType.PROPERTY_CARD, FleetDocumentStatus.VALID),
            ],
          }
        : {},
    );
    const svc = new OpsService(
      grpc(() => ({})),
      grpc(() => ({})),
      fleetGrpc,
      rest,
      noopMedia,
      noopReadModel,
      audit,
      config,
    );

    const err = await svc.approveDriver(identity, 'd1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(post).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});

describe('OpsService.driverDetail · core + biométrico + documentos con URLs firmadas', () => {
  it('mapea core ("" → null), firma docs con archivo (url) y deja null los sin archivo; audita view', async () => {
    const identityGrpc = grpc((m) =>
      m === 'GetDriver'
        ? {
            id: 'd1',
            userId: 'u-d1',
            currentStatus: 'PENDING_APPROVAL',
            backgroundCheckStatus: 'PENDING',
            averageRating: 0,
            found: true,
            suspendedAt: '',
            name: 'Khalid Ríos',
            rejectionReason: '',
            licenseNumber: 'A1-998877',
            kycStatus: 'VERIFIED',
            createdAt: '2026-06-01T10:00:00.000Z',
            faceEnrolledAt: '2026-06-02T08:00:00.000Z',
            lastVerifiedAt: '', // nunca verificó en vivo → null
            phone: '', // no registrado → null
          }
        : {},
    );
    const fleetGrpc = grpc((m) =>
      m === 'GetDriverDocuments'
        ? {
            driverId: 'd1',
            documents: [
              fleetDoc(FleetDocumentType.LICENSE_A1, FleetDocumentStatus.VALID, {
                id: 'doc-con-archivo',
                expiresAt: '2027-01-01T00:00:00.000Z',
                fileS3Key: 'drivers/d1/license.jpg',
              }),
              fleetDoc(FleetDocumentType.SOAT, FleetDocumentStatus.PENDING_REVIEW, {
                id: 'doc-sin-archivo',
              }),
            ],
          }
        : {},
    );
    const mediaPost = vi.fn().mockResolvedValue({ url: 'https://signed' });
    const media = { post: mediaPost } as unknown as InternalRestClient;
    const record = vi.fn().mockResolvedValue({ id: 'a', seq: '1', hash: 'h' });
    const audit = { record } as unknown as AuditRecorder;
    const svc = new OpsService(
      grpc(() => ({})),
      identityGrpc,
      fleetGrpc,
      noopRest,
      media,
      noopReadModel,
      audit,
      config,
    );

    const view = await svc.driverDetail(identity, 'd1');

    // Core: "" del proto → null honesto; valores reales pasan.
    expect(view.fullName).toBe('Khalid Ríos');
    expect(view.licenseNumber).toBe('A1-998877');
    expect(view.kycStatus).toBe('VERIFIED');
    expect(view.createdAt).toBe('2026-06-01T10:00:00.000Z');
    expect(view.phone).toBeNull();
    expect(view.biometric.faceEnrolledAt).toBe('2026-06-02T08:00:00.000Z');
    expect(view.biometric.lastVerifiedAt).toBeNull();
    // Doc con archivo → presigned url; doc sin archivo → null.
    const [withFile, withoutFile] = view.documents;
    expect(withFile?.url).toBe('https://signed');
    expect(withFile?.expiresAt).toBe('2027-01-01T00:00:00.000Z');
    expect(withoutFile?.url).toBeNull();
    expect(withoutFile?.rejectionReason).toBeNull();
    // Solo se firma el doc con archivo (1 sola llamada a media).
    expect(mediaPost).toHaveBeenCalledOnce();
    expect(mediaPost).toHaveBeenCalledWith('/media/internal/presign-get', {
      identity,
      body: { bucket: 'secret', key: 'drivers/d1/license.jpg', ttlSeconds: 120 },
    });
    // Ley 29733: ver documentos PII deja traza.
    expect(record).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({ action: 'driver.documents.view', resourceType: 'driver', resourceId: 'd1' }),
    );
  });

  it('lanza NotFoundError si el conductor no existe', async () => {
    const identityGrpc = grpc((m) => (m === 'GetDriver' ? { found: false } : {}));
    const fleetGrpc = grpc((m) =>
      m === 'GetDriverDocuments' ? { driverId: 'x', documents: [] } : {},
    );
    const svc = new OpsService(
      grpc(() => ({})),
      identityGrpc,
      fleetGrpc,
      noopRest,
      noopMedia,
      noopReadModel,
      noopAudit,
      config,
    );
    await expect(svc.driverDetail(identity, 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('OpsService.createOperator · anti-escalada en la capa BFF', () => {
  it('ADMIN → [SUPERADMIN]: ForbiddenError 403 que CORTA antes de identityRest.post', async () => {
    const post = vi.fn();
    const record = vi.fn();
    const rest = { post } as unknown as InternalRestClient;
    const audit = { record } as unknown as AuditRecorder;
    const svc = new OpsService(
      grpc(() => ({})),
      grpc(() => ({})),
      noopFleet,
      rest,
      noopMedia,
      noopReadModel,
      audit,
      config,
    );

    const err = await svc
      .createOperator(identity, 'op2@veo.pe', [AdminRole.SUPERADMIN])
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ForbiddenError);
    expect(post).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('ADMIN → [SUPPORT_L2]: pasa, llama al REST con email+roles y audita', async () => {
    const post = vi.fn().mockResolvedValue({
      id: 'op2',
      inviteToken: 'tok',
      inviteUrl: 'http://localhost:5001/accept-invite?token=tok',
      expiresAt: '2026-06-20T00:00:00.000Z',
    });
    const record = vi.fn().mockResolvedValue({ id: 'a', seq: '1', hash: 'h' });
    const rest = { post } as unknown as InternalRestClient;
    const audit = { record } as unknown as AuditRecorder;
    const svc = new OpsService(
      grpc(() => ({})),
      grpc(() => ({})),
      noopFleet,
      rest,
      noopMedia,
      noopReadModel,
      audit,
      config,
    );

    const out = await svc.createOperator(identity, 'op2@veo.pe', [AdminRole.SUPPORT_L2]);
    expect(out.id).toBe('op2');
    expect(out.inviteUrl).toContain('/accept-invite?token=');
    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith('/admin/operators', {
      identity,
      body: { email: 'op2@veo.pe', roles: [AdminRole.SUPPORT_L2] },
    });
    expect(record).toHaveBeenCalledOnce();
  });
});
