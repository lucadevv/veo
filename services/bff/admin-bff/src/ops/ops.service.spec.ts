import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpsService } from './ops.service';
import type { GrpcServiceClient, InternalRestClient } from '@veo/rpc';
import type { ConfigService } from '@nestjs/config';
import { InternalAudience, type AuthenticatedUser } from '@veo/auth';
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
const noopTripRest = {} as unknown as InternalRestClient;
const noopFleetRest = {} as unknown as InternalRestClient;
const noopPaymentRest = {} as unknown as InternalRestClient;
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
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
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
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
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
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
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
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
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

/** Las credenciales obligatorias (Ola 1: + foto del vehículo), todas VALID → el gate pasa. */
const allValidDocs = [
  fleetDoc(FleetDocumentType.LICENSE_A1, FleetDocumentStatus.VALID),
  fleetDoc(FleetDocumentType.SOAT, FleetDocumentStatus.VALID),
  fleetDoc(FleetDocumentType.PROPERTY_CARD, FleetDocumentStatus.VALID),
  fleetDoc(FleetDocumentType.VEHICLE_PHOTO, FleetDocumentStatus.VALID),
];

describe('OpsService.approveDriver · gate de documentos obligatorios (server-side, autoritativo)', () => {
  it('aprueba vía REST y audita cuando LICENSE_A1+SOAT+PROPERTY_CARD+VEHICLE_PHOTO están VALID', async () => {
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
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
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
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
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
            documentId: '12345678', // DNI (F2 · M2)
            birthDate: '1990-05-20', // yyyy-mm-dd (F2 · M2)
          }
        : {},
    );
    const fleetGrpc = grpc((m) => {
      if (m === 'GetDriverDocuments') {
        return {
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
        };
      }
      // F2 · C1: ficha del vehículo (el ACTIVO se prefiere). Keyed por userId (driver.userId).
      if (m === 'GetDriverVehicles') {
        return {
          driverId: 'u-d1',
          vehicles: [
            {
              id: 'veh-1',
              plate: 'ABC-123',
              make: 'Toyota',
              model: 'Yaris',
              year: 2021,
              color: 'Plata',
              docStatus: 'PENDING_REVIEW',
              active: true,
              found: true,
              vehicleType: 'CAR',
              status: 'PENDING_REVIEW',
            },
          ],
        };
      }
      return {};
    });
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
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
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
    // F2 · M2: DNI + fecha de nacimiento para la revisión del operador.
    expect(view.dni).toBe('12345678');
    expect(view.birthDate).toBe('1990-05-20');
    // F2 · C1: ficha del vehículo ACTIVO (el operador ve el auto antes de aprobar).
    expect(view.vehicle).toEqual({
      id: 'veh-1',
      plate: 'ABC-123',
      make: 'Toyota',
      model: 'Yaris',
      year: 2021,
      color: 'Plata',
      vehicleType: 'CAR',
      docStatus: 'PENDING_REVIEW',
      active: true,
    });
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
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
      noopReadModel,
      noopAudit,
      config,
    );
    await expect(svc.driverDetail(identity, 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('OpsService.runDniFaceMatch · orquesta el BINDING DNI↔selfie (sub-lote 3C)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** DNI con imagen FRONT (sub-lote 3A) — la cara que el face-match usa. */
  const dniWithFront = {
    id: 'doc-dni',
    ownerType: 'DRIVER',
    ownerId: 'd1',
    type: FleetDocumentType.DNI,
    documentNumber: '12345678',
    status: FleetDocumentStatus.PENDING_REVIEW,
    expiresAt: '',
    fileS3Key: '',
    rejectionReason: '',
    images: [
      { s3Key: 'drivers/d1/dni-front.jpg', side: 'FRONT', order: 0 },
      { s3Key: 'drivers/d1/dni-back.jpg', side: 'BACK', order: 1 },
    ],
  };

  it('baja la foto FRONT del DNI de S3, la pasa a identity y devuelve + audita el resultado', async () => {
    // fetch (descarga del binario S3 vía presigned) → bytes → base64.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
    );
    const fleetGrpc = grpc((m) =>
      m === 'GetDriverDocuments' ? { driverId: 'd1', documents: [dniWithFront] } : {},
    );
    const presignPost = vi.fn().mockResolvedValue({ url: 'https://signed/dni-front' });
    const media = { post: presignPost } as unknown as InternalRestClient;
    const identityPost = vi
      .fn()
      .mockResolvedValue({ matched: true, score: 94, reason: null });
    const identityRest = { post: identityPost } as unknown as InternalRestClient;
    const record = vi.fn().mockResolvedValue({ id: 'a', seq: '1', hash: 'h' });
    const audit = { record } as unknown as AuditRecorder;

    const svc = new OpsService(
      grpc(() => ({})),
      grpc(() => ({})),
      fleetGrpc,
      identityRest,
      media,
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
      noopReadModel,
      audit,
      config,
    );

    const out = await svc.runDniFaceMatch(identity, 'd1');

    expect(out).toEqual({ matched: true, score: 94, reason: null });
    // Presignó la clave de la imagen FRONT (no la BACK).
    expect(presignPost.mock.calls[0]?.[1]?.body?.key).toBe('drivers/d1/dni-front.jpg');
    // Llamó al identity con la imagen en base64 (los bytes [1,2,3,4]).
    expect(identityPost).toHaveBeenCalledWith(
      '/drivers/d1/dni-face-match',
      expect.objectContaining({ body: { image: Buffer.from([1, 2, 3, 4]).toString('base64') } }),
    );
    // Auditó la verificación (Ley 29733).
    expect(record).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({ action: 'driver.dni-face-match' }),
    );
  });

  it('sin foto FRONT del DNI → 409 (ConflictError) sin llamar a identity', async () => {
    const fleetGrpc = grpc((m) =>
      m === 'GetDriverDocuments' ? { driverId: 'd1', documents: [] } : {},
    );
    const identityPost = vi.fn();
    const identityRest = { post: identityPost } as unknown as InternalRestClient;
    const svc = new OpsService(
      grpc(() => ({})),
      grpc(() => ({})),
      fleetGrpc,
      identityRest,
      noopMedia,
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
      noopReadModel,
      noopAudit,
      config,
    );
    await expect(svc.runDniFaceMatch(identity, 'd1')).rejects.toBeInstanceOf(ConflictError);
    expect(identityPost).not.toHaveBeenCalled();
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
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
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
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
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

describe('OpsService.purgeDriver · HARD purge en cascada + guard de historial', () => {
  const superadmin: AuthenticatedUser = {
    userId: 'sa1',
    type: 'admin',
    roles: [AdminRole.SUPERADMIN],
    sessionId: 's1',
  };

  function restWith(impl: Partial<Record<'get' | 'post' | 'delete', unknown>>): InternalRestClient {
    return impl as unknown as InternalRestClient;
  }

  // Cada caso fija su propio NODE_ENV (prod para el guard, dev para el cascade); restauramos siempre.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('GUARD (PROD): conductor con historial de viajes → 409 ConflictError, NO borra nada', async () => {
    // El guard SOLO bloquea en entorno endurecido (NODE_ENV=production). Lo forzamos para este caso —
    // en DEV el superadmin SÍ puede purgar conductores con viajes (data de prueba; ver el caso de abajo).
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const tripRest = restWith({
        get: vi.fn().mockResolvedValue({ driverId: 'd1', tripCount: 7, hasTrips: true }),
      });
      const identityDelete = vi.fn();
      const identityRest = restWith({ delete: identityDelete });
      const fleetDelete = vi.fn();
      const fleetRest = restWith({ delete: fleetDelete });
      const paymentDelete = vi.fn();
      const paymentRest = restWith({ delete: paymentDelete });
      const record = vi.fn();
      const audit = { record } as unknown as AuditRecorder;
      const svc = new OpsService(
        grpc(() => ({})),
        grpc(() => ({})),
        noopFleet,
        identityRest,
        noopMedia,
        tripRest,
        fleetRest,
        paymentRest,
        InternalAudience.ADMIN_RAIL,
        noopReadModel,
        audit,
        config,
      );

      const err = await svc.purgeDriver(superadmin, 'd1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictError);
      // fail-closed: ni identity ni fleet ni payment ni audit se tocaron.
      expect(identityDelete).not.toHaveBeenCalled();
      expect(fleetDelete).not.toHaveBeenCalled();
      expect(paymentDelete).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('DEV-relajado: conductor CON viajes → el purge PROCEDE y cascada trips + payments (no bloquea)', async () => {
    // En DEV (NODE_ENV != production) el guard NO bloquea aunque el conductor tenga viajes: es data de
    // prueba. El cascade entonces hard-borra trips + payments para no dejar huérfanos.
    vi.stubEnv('NODE_ENV', 'test');
    // El guard destructivo ahora corre por VEO_DEPLOY_TIER (isProdTier), no por NODE_ENV: en dev/preview
    // la purga PROCEDE (default seguro = production bloquea). Forzamos tier local para el caso DEV-relajado.
    vi.stubEnv('VEO_DEPLOY_TIER', 'local');
    const tripDelete = vi.fn().mockResolvedValue({ ...tripPurgeReply, trips: 7 });
    const tripRest = restWith({
      get: vi.fn().mockResolvedValue({ driverId: 'd1', tripCount: 7, hasTrips: true }),
      delete: tripDelete,
    });
    const identityRest = restWith({
      delete: vi.fn().mockResolvedValue({
        userId: 'u1',
        deleted: { driver: 1, authMethods: 0, biometricChecks: 0, consents: 0, user: 1 },
      }),
    });
    const fleetRest = restWith({
      delete: vi.fn().mockResolvedValue({ documents: 0, vehicles: 0, vehicleDocuments: 0 }),
    });
    const mediaRest = restWith({ delete: vi.fn().mockResolvedValue({ deleted: 0 }) });
    const paymentDelete = vi.fn().mockResolvedValue(paymentPurgeReply);
    const paymentRest = restWith({ delete: paymentDelete });
    const removeDriver = vi.fn().mockResolvedValue(true);
    const readModel = { removeDriver } as unknown as ReadModelService;
    const record = vi.fn().mockResolvedValue({ id: 'a', seq: '1', hash: 'h' });
    const audit = { record } as unknown as AuditRecorder;
    const svc = new OpsService(
      grpc(() => ({})),
      grpc(() => ({})),
      noopFleet,
      identityRest,
      mediaRest,
      tripRest,
      fleetRest,
      paymentRest,
      InternalAudience.ADMIN_RAIL,
      readModel,
      audit,
      config,
    );

    const out = await svc.purgeDriver(superadmin, 'd1');

    // NO bloqueó: borró trips + payments del conductor de prueba.
    expect(out.trip?.trips).toBe(7);
    expect(out.payment).toEqual(paymentPurgeReply);
    expect(tripDelete).toHaveBeenCalledWith('/internal/drivers/d1/trips', { identity: superadmin });
    expect(paymentDelete).toHaveBeenCalledWith('/internal/drivers/d1/payments', {
      identity: superadmin,
      query: { userId: 'u1' },
    });
    expect(out.partialFailures).toBeUndefined();
  });

  // Shapes de respuesta del cascade DEV (trip-service / payment-service).
  const tripPurgeReply = { driverId: 'd1', trips: 3, tripEvents: 9, waypointProposals: 1 };
  const paymentPurgeReply = {
    driverId: 'd1',
    userId: 'u1',
    byDriverId: {
      cancellationPenalties: 1,
      incentiveProgress: 2,
      incentiveTripCredits: 4,
      payments: 5,
      payouts: 1,
      refunds: 2,
      tipAdditions: 3,
    },
    byUserId: {
      promoRedemptions: 1,
      userCreditEntries: 2,
      userCredits: 1,
      walletAffiliations: 1,
    },
  };

  it('sin viajes (DEV) → purga identity→fleet→media→trip→payment→proyección, audita y devuelve contadores', async () => {
    // Forzamos DEV explícito: en CI (NODE_ENV=production) el cascade NO borraría trips/payments; este caso
    // valida el camino DEV de forma determinista bajo cualquier env. `vi.unstubAllEnvs` restaura al final.
    vi.stubEnv('NODE_ENV', 'test');
    // El guard destructivo ahora corre por VEO_DEPLOY_TIER (isProdTier), no por NODE_ENV: en dev/preview
    // la purga PROCEDE (default seguro = production bloquea). Forzamos tier local para el caso DEV-relajado.
    vi.stubEnv('VEO_DEPLOY_TIER', 'local');
    const tripDelete = vi.fn().mockResolvedValue(tripPurgeReply);
    const tripRest = restWith({
      get: vi.fn().mockResolvedValue({ driverId: 'd1', tripCount: 0, hasTrips: false }),
      delete: tripDelete,
    });
    const identityRest = restWith({
      delete: vi.fn().mockResolvedValue({
        userId: 'u1',
        deleted: { driver: 1, authMethods: 2, biometricChecks: 3, consents: 1, user: 1 },
      }),
    });
    const fleetDelete = vi
      .fn()
      .mockResolvedValue({ documents: 2, vehicles: 1, vehicleDocuments: 1 });
    const fleetRest = restWith({ delete: fleetDelete });
    const mediaDelete = vi.fn().mockResolvedValue({ deleted: 4 });
    const mediaRest = restWith({ delete: mediaDelete });
    const paymentDelete = vi.fn().mockResolvedValue(paymentPurgeReply);
    const paymentRest = restWith({ delete: paymentDelete });
    const removeDriver = vi.fn().mockResolvedValue(true);
    const readModel = { removeDriver } as unknown as ReadModelService;
    const record = vi.fn().mockResolvedValue({ id: 'a', seq: '1', hash: 'h' });
    const audit = { record } as unknown as AuditRecorder;

    const svc = new OpsService(
      grpc(() => ({})),
      grpc(() => ({})),
      noopFleet,
      identityRest,
      mediaRest,
      tripRest,
      fleetRest,
      paymentRest,
      InternalAudience.ADMIN_RAIL,
      readModel,
      audit,
      config,
    );

    const out = await svc.purgeDriver(superadmin, 'd1');

    expect(out.userId).toBe('u1');
    expect(out.identity).toEqual({
      driver: 1,
      authMethods: 2,
      biometricChecks: 3,
      consents: 1,
      user: 1,
    });
    expect(out.fleet).toEqual({ documents: 2, vehicles: 1, vehicleDocuments: 1 });
    expect(out.media).toEqual({ deleted: 4 });
    // En DEV el cascade SÍ borra trips + payments (sin huérfanos).
    expect(out.trip).toEqual(tripPurgeReply);
    expect(out.payment).toEqual(paymentPurgeReply);
    expect(out.projection).toEqual({ removed: true });
    expect(out.partialFailures).toBeUndefined();
    // fleet recibe el DRIVERID en la ruta (indexa docs) + el userId en query (indexa vehículos).
    expect(fleetDelete).toHaveBeenCalledWith('/vehicles/drivers/d1', {
      identity: superadmin,
      query: { userId: 'u1' },
    });
    // media recibe el DRIVERID (S3 organiza los binarios por drivers/<driverId>/).
    expect(mediaDelete).toHaveBeenCalledWith('/media/internal/drivers/d1/documents', {
      identity: superadmin,
      body: { bucket: 'secret' },
    });
    // trip recibe el DRIVERID (Trip.driverId = driverId).
    expect(tripDelete).toHaveBeenCalledWith('/internal/drivers/d1/trips', { identity: superadmin });
    // payment recibe el DRIVERID en la ruta + el userId en query (indexa 4 tablas por user_id).
    expect(paymentDelete).toHaveBeenCalledWith('/internal/drivers/d1/payments', {
      identity: superadmin,
      query: { userId: 'u1' },
    });
    expect(removeDriver).toHaveBeenCalledWith('d1');
    expect(record).toHaveBeenCalledWith(
      superadmin,
      expect.objectContaining({ action: 'driver.purge', resourceType: 'driver', resourceId: 'd1' }),
    );
  });

  it('RESILIENCIA: si falla fleet, igual limpia la proyección Redis y reporta el parcial (NO deja al conductor en la lista)', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    // El guard destructivo ahora corre por VEO_DEPLOY_TIER (isProdTier), no por NODE_ENV: en dev/preview
    // la purga PROCEDE (default seguro = production bloquea). Forzamos tier local para el caso DEV-relajado.
    vi.stubEnv('VEO_DEPLOY_TIER', 'local');
    const tripRest = restWith({
      get: vi.fn().mockResolvedValue({ driverId: 'd1', tripCount: 0, hasTrips: false }),
    });
    const identityRest = restWith({
      delete: vi.fn().mockResolvedValue({
        userId: 'u1',
        deleted: { driver: 1, authMethods: 0, biometricChecks: 0, consents: 0, user: 1 },
      }),
    });
    const fleetRest = restWith({ delete: vi.fn().mockRejectedValue(new Error('fleet down')) });
    const mediaDelete = vi.fn().mockResolvedValue({ deleted: 4 });
    const mediaRest = restWith({ delete: mediaDelete });
    const tripDelete = vi.fn().mockResolvedValue(tripPurgeReply);
    (tripRest as { delete?: unknown }).delete = tripDelete;
    const paymentDelete = vi.fn().mockResolvedValue(paymentPurgeReply);
    const paymentRest = restWith({ delete: paymentDelete });
    const removeDriver = vi.fn().mockResolvedValue(true);
    const readModel = { removeDriver } as unknown as ReadModelService;
    const record = vi.fn().mockResolvedValue({ id: 'a', seq: '1', hash: 'h' });
    const audit = { record } as unknown as AuditRecorder;
    const svc = new OpsService(
      grpc(() => ({})),
      grpc(() => ({})),
      noopFleet,
      identityRest,
      mediaRest,
      tripRest,
      fleetRest,
      paymentRest,
      InternalAudience.ADMIN_RAIL,
      readModel,
      audit,
      config,
    );

    const out = await svc.purgeDriver(superadmin, 'd1');

    // El conductor YA NO está en la proyección, aunque fleet haya fallado.
    expect(removeDriver).toHaveBeenCalledWith('d1');
    expect(out.projection).toEqual({ removed: true });
    // media/trip/payment SÍ corren aunque fleet haya fallado (best-effort, no se aborta la cascada).
    expect(mediaDelete).toHaveBeenCalledOnce();
    expect(tripDelete).toHaveBeenCalledOnce();
    expect(paymentDelete).toHaveBeenCalledOnce();
    // El parcial se reporta honestamente (sin mentir "todo borrado") y SOLO incluye fleet.
    expect(out.partialFailures).toEqual([{ stage: 'fleet', cause: 'fleet down' }]);
    expect(out.fleet).toEqual({ documents: 0, vehicles: 0, vehicleDocuments: 0 });
    expect(out.trip).toEqual(tripPurgeReply);
    expect(out.payment).toEqual(paymentPurgeReply);
    // Se audita la purga (incluido el parcial), porque identity SÍ borró.
    expect(record).toHaveBeenCalledWith(
      superadmin,
      expect.objectContaining({
        action: 'driver.purge',
        payload: expect.objectContaining({
          partialFailures: [{ stage: 'fleet', cause: 'fleet down' }],
        }),
      }),
    );
  });

  it('RESILIENCIA: si falla media, igual limpia la proyección y reporta el parcial de media', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    // El guard destructivo ahora corre por VEO_DEPLOY_TIER (isProdTier), no por NODE_ENV: en dev/preview
    // la purga PROCEDE (default seguro = production bloquea). Forzamos tier local para el caso DEV-relajado.
    vi.stubEnv('VEO_DEPLOY_TIER', 'local');
    const tripRest = restWith({
      get: vi.fn().mockResolvedValue({ driverId: 'd1', tripCount: 0, hasTrips: false }),
    });
    const identityRest = restWith({
      delete: vi.fn().mockResolvedValue({
        userId: 'u1',
        deleted: { driver: 1, authMethods: 0, biometricChecks: 0, consents: 0, user: 1 },
      }),
    });
    const fleetDelete = vi
      .fn()
      .mockResolvedValue({ documents: 5, vehicles: 2, vehicleDocuments: 0 });
    const fleetRest = restWith({ delete: fleetDelete });
    const mediaRest = restWith({ delete: vi.fn().mockRejectedValue(new Error('s3 down')) });
    const tripDelete = vi.fn().mockResolvedValue(tripPurgeReply);
    (tripRest as { delete?: unknown }).delete = tripDelete;
    const paymentDelete = vi.fn().mockResolvedValue(paymentPurgeReply);
    const paymentRest = restWith({ delete: paymentDelete });
    const removeDriver = vi.fn().mockResolvedValue(true);
    const readModel = { removeDriver } as unknown as ReadModelService;
    const record = vi.fn().mockResolvedValue({ id: 'a', seq: '1', hash: 'h' });
    const audit = { record } as unknown as AuditRecorder;
    const svc = new OpsService(
      grpc(() => ({})),
      grpc(() => ({})),
      noopFleet,
      identityRest,
      mediaRest,
      tripRest,
      fleetRest,
      paymentRest,
      InternalAudience.ADMIN_RAIL,
      readModel,
      audit,
      config,
    );

    const out = await svc.purgeDriver(superadmin, 'd1');

    expect(removeDriver).toHaveBeenCalledWith('d1');
    expect(out.projection).toEqual({ removed: true });
    expect(out.fleet).toEqual({ documents: 5, vehicles: 2, vehicleDocuments: 0 });
    expect(out.media).toEqual({ deleted: 0 });
    // trip/payment SÍ corren aunque media haya fallado; el parcial SOLO incluye media.
    expect(out.trip).toEqual(tripPurgeReply);
    expect(out.payment).toEqual(paymentPurgeReply);
    expect(out.partialFailures).toEqual([{ stage: 'media', cause: 's3 down' }]);
  });
});
