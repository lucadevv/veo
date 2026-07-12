import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpsService } from './ops.service';
import type { GrpcServiceClient, InternalRestClient } from '@veo/rpc';
import type { MapsClient } from '@veo/maps';
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
// Maps mock: reverse determinista (label fijo) → prueba el camino feliz del reverse-geocode del detalle.
const noopMaps = {
  reverse: async (p: { lat: number; lon: number }) => ({
    lat: p.lat,
    lon: p.lon,
    displayName: 'Av. Ejemplo 123, Miraflores',
  }),
} as unknown as MapsClient;
// fleet sin vehículos → vehiclePlate null; el batch de completitud devuelve el shape vacío honesto (items: []).
const noopFleet = grpc((m) => (m === 'GetDriverDocsCompleteness' ? { items: [] } : {}));

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

    const fleetGrpc = grpc((m) => {
      if (m === 'GetDriverVehicles')
        return {
          driverId: 'd1',
          vehicles: [{ id: 'v1', plate: 'ABC-123', active: true, found: true }],
        };
      if (m === 'GetDriverDocsCompleteness') return { items: [] };
      return {};
    });
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
      noopMaps,
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
    // Reverse-geocode (rol con geo EXACTA): la dirección legible del puerto soberano @veo/maps.
    expect(view.originLabel).toBe('Av. Ejemplo 123, Miraflores');
    expect(view.destinationLabel).toBe('Av. Ejemplo 123, Miraflores');
    expect(view.passengerName).toBe('Ana Pérez');
    expect(view.driverName).toBe('Khalid Ríos');
    // El proto manda suspendedAt (identity) y la view del panel YA NO lo pierde (drift cerrado).
    expect(view.driverSuspendedAt).toBe('2026-06-02T08:00:00.000Z');
    expect(view.paymentMethod).toBe('YAPE');
    // Duración REAL del viaje (Trip.durationSeconds del GetTrip) → el detalle ya no muestra "—".
    expect(view.durationSeconds).toBe(1200);
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
    const fleetGrpc = grpc((m) => {
      if (m === 'GetDriverVehicles')
        return { vehicles: [{ id: 'v1', plate: 'ABC-123', active: true, found: true }] };
      if (m === 'GetDriverDocsCompleteness') return { items: [] };
      return {};
    });
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
      noopMaps,
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
    // DIRECCIÓN → null: sin geo exacta no se revela la calle precisa (el reverse-geocode ni se llama).
    expect(view.originLabel).toBeNull();
    expect(view.destinationLabel).toBeNull();
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
      noopMaps,
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
      noopMaps,
      noopReadModel,
      noopAudit,
      config,
    );
    await expect(svc.tripDetail(identity, 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('OpsService.listTrips · enrichment de nombres (anti-N+1 + redacción PII)', () => {
  const records = [
    {
      id: 't1',
      status: 'IN_PROGRESS' as const,
      passengerId: 'p1',
      driverId: 'd1',
      fareCents: 1500,
      createdAt: '2026-06-01T10:00:00.000Z',
    },
    {
      id: 't2',
      status: 'COMPLETED' as const,
      passengerId: 'p2',
      driverId: null,
      fareCents: 2000,
      createdAt: '2026-06-01T11:00:00.000Z',
    },
  ];

  function svcWith(idImpl: (method: string) => unknown) {
    const readModel = {
      listTrips: vi.fn().mockResolvedValue({ items: records, nextCursor: null }),
    } as unknown as ReadModelService;
    const identityGrpc = grpc(idImpl);
    const svc = new OpsService(
      grpc(() => ({})),
      identityGrpc,
      noopFleet,
      noopRest,
      noopMedia,
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
      noopMaps,
      readModel,
      noopAudit,
      config,
    );
    return { svc, identityGrpc };
  }

  it('ADMIN: resuelve passengerName/driverName con UN batch cada uno (anti-N+1)', async () => {
    const { svc, identityGrpc } = svcWith((m) => {
      if (m === 'GetUsersByIds')
        return { users: [{ id: 'p1', name: 'María Q.', found: true }, { id: 'p2', name: 'Lucía F.', found: true }] };
      if (m === 'GetDriversByIds') return { drivers: [{ id: 'd1', name: 'José R.', found: true }] };
      return {};
    });
    const page = await svc.listTrips(identity, {});
    expect(page.items[0]).toMatchObject({ passengerName: 'María Q.', driverName: 'José R.' });
    // t2 sin conductor → driverName null honesto; pasajero igual se resuelve.
    expect(page.items[1]).toMatchObject({ passengerName: 'Lucía F.', driverName: null });
    // Anti-N+1: UN GetUsersByIds y UN GetDriversByIds para TODA la página (no por fila).
    const calls = (identityGrpc.call as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls.filter((m) => m === 'GetUsersByIds')).toHaveLength(1);
    expect(calls.filter((m) => m === 'GetDriversByIds')).toHaveLength(1);
  });

  it('SUPPORT_L1 (sub-Compliance): nombres null y NO llama a identity (PII gateada)', async () => {
    const { svc, identityGrpc } = svcWith(() => ({}));
    const support: AuthenticatedUser = { ...identity, roles: ['SUPPORT_L1'] };
    const page = await svc.listTrips(support, {});
    expect(page.items[0]).toMatchObject({ passengerName: null, driverName: null });
    // Sin permiso de identidad → ni siquiera se piden los nombres (cero llamadas gRPC).
    expect(identityGrpc.call).not.toHaveBeenCalled();
  });
});

/** Documento de flota mínimo para los specs del gate de aprobación / detalle. */
function fleetDoc(
  type: FleetDocumentType,
  status: FleetDocumentStatus,
  overrides: Partial<{
    id: string;
    expiresAt: string;
    rejectionReason: string;
    fileS3Key: string;
  }> = {},
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

/** identity GetDriver mínimo (resuelve el userId del driver para el gate de ITV). */
const driverFound = { id: 'd1', userId: 'u-d1', found: true };
/** identity grpc que responde GetDriver con el userId; el resto vacío. */
const identityGrpcWithDriver = grpc((m) => (m === 'GetDriver' ? driverFound : {}));
/** fleet GetDriverInspectionStatus VIGENTE (gate ITV pasa). */
const inspectionCurrent = {
  current: true,
  hasVehicle: true,
  vehicleId: 'veh-1',
  plate: 'ABC-123',
  nextDueAt: '2099-01-01T00:00:00.000Z',
  passed: true,
  invalidReason: '',
};

/** fleet grpc: GetDriverDocuments con los `docs` dados + GetDriverInspectionStatus con el `inspection` dado. */
function fleetGrpcFor(
  docs: unknown[],
  inspection: Record<string, unknown> = inspectionCurrent,
): GrpcServiceClient {
  return grpc((m) => {
    if (m === 'GetDriverDocuments') return { driverId: 'd1', documents: docs };
    if (m === 'GetDriverInspectionStatus') return inspection;
    return {};
  });
}

describe('OpsService.approveDriver · gates server-side (documentos + ITV, autoritativos)', () => {
  it('aprueba vía REST y audita cuando docs VALID Y la ITV del vehículo operado está vigente', async () => {
    const rest = {
      post: vi.fn().mockResolvedValue({ id: 'd1', backgroundCheckStatus: 'CLEARED' }),
    } as unknown as InternalRestClient;
    const audit = {
      record: vi.fn().mockResolvedValue({ id: 'a', seq: '1', hash: 'h' }),
    } as unknown as AuditRecorder;
    const svc = new OpsService(
      grpc(() => ({})),
      identityGrpcWithDriver,
      fleetGrpcFor(allValidDocs),
      rest,
      noopMedia,
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
      noopMaps,
      noopReadModel,
      audit,
      config,
    );
    const out = await svc.approveDriver(identity, 'd1');
    expect(out.backgroundCheckStatus).toBe('CLEARED');
    expect(rest.post).toHaveBeenCalledWith('/drivers/d1/approve', { identity });
    expect(audit.record).toHaveBeenCalledOnce();
  });

  it('GATE DOCS: ConflictError y NO llama a identity approve cuando falta el SOAT válido', async () => {
    const post = vi.fn();
    const record = vi.fn();
    const rest = { post } as unknown as InternalRestClient;
    const audit = { record } as unknown as AuditRecorder;
    // SOAT presente pero EXPIRED (no VALID) → no satisface el gate documental (corta ANTES del de ITV).
    const fleetGrpc = fleetGrpcFor([
      fleetDoc(FleetDocumentType.LICENSE_A1, FleetDocumentStatus.VALID),
      fleetDoc(FleetDocumentType.SOAT, FleetDocumentStatus.EXPIRED),
      fleetDoc(FleetDocumentType.PROPERTY_CARD, FleetDocumentStatus.VALID),
    ]);
    const svc = new OpsService(
      grpc(() => ({})),
      identityGrpcWithDriver,
      fleetGrpc,
      rest,
      noopMedia,
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
      noopMaps,
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

describe('OpsService.approveDriver · GATE de inspección técnica (ITV · compliance)', () => {
  /** Construye el service con la ITV-status dada (docs siempre VALID; el bloqueo es por ITV). */
  function svcWithInspection(
    inspectionStatus: Record<string, unknown>,
    rest: InternalRestClient,
    audit: AuditRecorder,
  ): OpsService {
    return new OpsService(
      grpc(() => ({})),
      identityGrpcWithDriver,
      fleetGrpcFor(allValidDocs, inspectionStatus),
      rest,
      noopMedia,
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
      noopMaps,
      noopReadModel,
      audit,
      config,
    );
  }

  it('resuelve la ITV por USERID (no driverId): GetDriverInspectionStatus se llama con driver.userId', async () => {
    const calls: { method: string; req: Record<string, unknown> }[] = [];
    const fleetGrpc = {
      call: vi.fn((method: string, req: Record<string, unknown>) => {
        calls.push({ method, req });
        if (method === 'GetDriverDocuments')
          return Promise.resolve({ driverId: 'd1', documents: allValidDocs });
        if (method === 'GetDriverInspectionStatus') return Promise.resolve(inspectionCurrent);
        return Promise.resolve({});
      }),
    } as unknown as GrpcServiceClient;
    const rest = {
      post: vi.fn().mockResolvedValue({ id: 'd1', backgroundCheckStatus: 'CLEARED' }),
    } as unknown as InternalRestClient;
    const svc = new OpsService(
      grpc(() => ({})),
      identityGrpcWithDriver,
      fleetGrpc,
      rest,
      noopMedia,
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
      noopMaps,
      noopReadModel,
      noopAudit,
      config,
    );

    await svc.approveDriver(identity, 'd1');
    const inspectionCall = calls.find((c) => c.method === 'GetDriverInspectionStatus');
    // La pieza que más rompe: la ITV se consulta con el USER.id (driver.userId), NO con el driverId de perfil.
    expect(inspectionCall?.req).toEqual({ id: 'u-d1' });
  });

  it('BLOQUEA (ConflictError) con ITV VENCIDA y NO llama a identity approve', async () => {
    const post = vi.fn();
    const record = vi.fn();
    const svc = svcWithInspection(
      { ...inspectionCurrent, current: false, passed: true, invalidReason: 'OVERDUE' },
      { post } as unknown as InternalRestClient,
      { record } as unknown as AuditRecorder,
    );
    const err = await svc.approveDriver(identity, 'd1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toContain('vencida');
    expect(post).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('BLOQUEA con ITV REPROBADA (passed=false → NOT_PASSED)', async () => {
    const post = vi.fn();
    const svc = svcWithInspection(
      { ...inspectionCurrent, current: false, passed: false, invalidReason: 'NOT_PASSED' },
      { post } as unknown as InternalRestClient,
      { record: vi.fn() } as unknown as AuditRecorder,
    );
    const err = await svc.approveDriver(identity, 'd1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toContain('reprobada');
    expect(post).not.toHaveBeenCalled();
  });

  it('BLOQUEA sin vehículo (NO_VEHICLE): no puede operar sin vehículo + ITV', async () => {
    const post = vi.fn();
    const svc = svcWithInspection(
      {
        current: false,
        hasVehicle: false,
        vehicleId: '',
        plate: '',
        nextDueAt: '',
        passed: false,
        invalidReason: 'NO_VEHICLE',
      },
      { post } as unknown as InternalRestClient,
      { record: vi.fn() } as unknown as AuditRecorder,
    );
    const err = await svc.approveDriver(identity, 'd1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toContain('vehículo operable');
    expect(post).not.toHaveBeenCalled();
  });

  it('BLOQUEA sin inspección (NONE)', async () => {
    const post = vi.fn();
    const svc = svcWithInspection(
      { ...inspectionCurrent, current: false, passed: false, nextDueAt: '', invalidReason: 'NONE' },
      { post } as unknown as InternalRestClient,
      { record: vi.fn() } as unknown as AuditRecorder,
    );
    const err = await svc.approveDriver(identity, 'd1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toContain('no tiene inspección');
    expect(post).not.toHaveBeenCalled();
  });

  it('NotFoundError si el conductor no existe en identity (no se puede resolver el userId)', async () => {
    const post = vi.fn();
    const identityGrpc = grpc((m) => (m === 'GetDriver' ? { found: false } : {}));
    const svc = new OpsService(
      grpc(() => ({})),
      identityGrpc,
      fleetGrpcFor(allValidDocs),
      { post } as unknown as InternalRestClient,
      noopMedia,
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
      noopMaps,
      noopReadModel,
      noopAudit,
      config,
    );
    await expect(svc.approveDriver(identity, 'd1')).rejects.toBeInstanceOf(NotFoundError);
    expect(post).not.toHaveBeenCalled();
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
      // F2 · C1: ficha del vehículo OPERADO. FIX 3 — el display admin usa el MISMO selector autoritativo que
      // el gate de ITV/dispatch/ping: GetDriverActiveVehicle (pickActiveVehicle), keyed por userId.
      if (m === 'GetDriverActiveVehicle') {
        return {
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
      noopMaps,
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
      expect.objectContaining({
        action: 'driver.documents.view',
        resourceType: 'driver',
        resourceId: 'd1',
      }),
    );
    // FIX 3: conductor NO suspendido (proto omite suspensionCauses) → [] honesto (degradación del repeated).
    expect(view.suspensionCauses).toEqual([]);
  });

  it('FIX 3: expone las CAUSAS de suspensión para que el panel elija el endpoint de reactivación', async () => {
    // El conductor está suspendido por DOS causas: un documento vencido (→ /reactivate-compliance) y una
    // disciplinaria (→ /reactivate). El panel necesita VER ambas para ofrecer la(s) acción(es) correcta(s).
    const identityGrpc = grpc((m) =>
      m === 'GetDriver'
        ? {
            id: 'd1',
            userId: 'u-d1',
            currentStatus: 'SUSPENDED',
            backgroundCheckStatus: 'CLEARED',
            averageRating: 4.5,
            found: true,
            suspendedAt: '2026-06-01T00:00:00.000Z',
            name: 'Khalid Ríos',
            rejectionReason: '',
            licenseNumber: 'A1-998877',
            kycStatus: 'VERIFIED',
            createdAt: '2026-06-01T10:00:00.000Z',
            faceEnrolledAt: '',
            lastVerifiedAt: '',
            phone: '',
            documentId: '',
            birthDate: '',
            suspensionCauses: ['DOCUMENT_EXPIRED', 'DISCIPLINARY'],
          }
        : {},
    );
    const fleetGrpc = grpc((m) =>
      m === 'GetDriverDocuments' ? { driverId: 'd1', documents: [] } : {},
    );
    const record = vi.fn().mockResolvedValue({ id: 'a', seq: '1', hash: 'h' });
    const audit = { record } as unknown as AuditRecorder;
    const svc = new OpsService(
      grpc(() => ({})),
      identityGrpc,
      fleetGrpc,
      noopRest,
      { post: vi.fn() } as unknown as InternalRestClient,
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
      noopMaps,
      noopReadModel,
      audit,
      config,
    );

    const view = await svc.driverDetail(identity, 'd1');

    // El panel distingue las causas → ofrece /reactivate (DISCIPLINARY) y /reactivate-compliance (DOCUMENT_EXPIRED).
    expect(view.suspensionCauses).toEqual(['DOCUMENT_EXPIRED', 'DISCIPLINARY']);
    // El flag derivado de "está suspendido" se mantiene en paralelo.
    expect(view.currentStatus).toBe('SUSPENDED');
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
      noopMaps,
      noopReadModel,
      noopAudit,
      config,
    );
    await expect(svc.driverDetail(identity, 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  // FIX 3 · CONSISTENCIA: el display admin del "vehículo operado" usa el MISMO selector autoritativo que el
  // gate de ITV / dispatch / ping. Antes resolvía con `GetDriverVehicles` + `find(active) ?? [0]`, un
  // selector DIVERGENTE de `pickActiveVehicle` → el operador podía ver un auto que NO es el que el gate
  // evalúa al aprobar. Ahora consume `GetDriverActiveVehicle` (la fuente única), keyed por userId.
  describe('FIX 3 · vehículo del detalle = el MISMO que evalúa el gate (selector único)', () => {
    function driverDetailService(fleetImpl: (m: string, req: Record<string, unknown>) => unknown) {
      const identityGrpc = grpc((m) =>
        m === 'GetDriver'
          ? {
              id: 'd1',
              userId: 'u-d1',
              found: true,
              name: 'X',
              suspendedAt: '',
              rejectionReason: '',
            }
          : {},
      );
      const fleetGrpc = grpc(fleetImpl);
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
        noopMaps,
        noopReadModel,
        noopAudit,
        config,
      );
      return { svc, fleetGrpc };
    }

    it('resuelve el vehículo vía GetDriverActiveVehicle (keyed por userId), NO con el selector divergente', async () => {
      const { svc, fleetGrpc } = driverDetailService((m) => {
        if (m === 'GetDriverDocuments') return { driverId: 'd1', documents: [] };
        if (m === 'GetDriverActiveVehicle')
          return {
            id: 'veh-operado',
            plate: 'XYZ-789',
            make: 'Kia',
            model: 'Rio',
            year: 2022,
            color: 'Negro',
            docStatus: 'VALID',
            active: true,
            found: true,
            vehicleType: 'CAR',
            status: 'ACTIVE',
          };
        return {};
      });

      const view = await svc.driverDetail(identity, 'd1');

      expect(view.vehicle?.id).toBe('veh-operado');
      const calledMethods = (fleetGrpc.call as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0],
      );
      expect(calledMethods).toContain('GetDriverActiveVehicle');
      // El display NO debe reusar el selector divergente para la ficha del vehículo.
      expect(calledMethods).not.toContain('GetDriverVehicles');
      // Keyed por el User.id (driver.userId), no por el driverId de perfil.
      const activeCall = (fleetGrpc.call as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => c[0] === 'GetDriverActiveVehicle',
      );
      expect(activeCall?.[1]).toEqual({ id: 'u-d1' });
    });

    it('found=false (ningún vehículo operable) → vehicle null (degradación honesta)', async () => {
      const { svc } = driverDetailService((m) => {
        if (m === 'GetDriverDocuments') return { driverId: 'd1', documents: [] };
        if (m === 'GetDriverActiveVehicle') return { found: false };
        return {};
      });
      const view = await svc.driverDetail(identity, 'd1');
      expect(view.vehicle).toBeNull();
    });
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
    // Set requerido SUBIDO (el gate de inicio de verificación #2 exige presencia) + el DNI con su FRONT.
    const fleetGrpc = grpc((m) =>
      m === 'GetDriverDocuments'
        ? { driverId: 'd1', documents: [...allValidDocs, dniWithFront] }
        : {},
    );
    const presignPost = vi.fn().mockResolvedValue({ url: 'https://signed/dni-front' });
    const media = { post: presignPost } as unknown as InternalRestClient;
    const identityPost = vi.fn().mockResolvedValue({ matched: true, score: 94, reason: null });
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
      noopMaps,
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
    // Docs requeridos SUBIDOS (pasa el gate #2) pero SIN el DNI → falla en el lookup del FRONT del DNI, no en
    // el gate. Así el test sigue ejercitando el path del FRONT faltante (no lo enmascara el gate de presencia).
    const fleetGrpc = grpc((m) =>
      m === 'GetDriverDocuments' ? { driverId: 'd1', documents: [...allValidDocs] } : {},
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
      noopMaps,
      noopReadModel,
      noopAudit,
      config,
    );
    await expect(svc.runDniFaceMatch(identity, 'd1')).rejects.toBeInstanceOf(ConflictError);
    expect(identityPost).not.toHaveBeenCalled();
  });

  it('#2 GATE — docs requeridos SIN subir → BLOQUEA la verificación (ConflictError) sin llamar a identity', async () => {
    // Falta el SOAT (no subido). El operador NO puede empezar el face-match: es un BLOQUEO, no un rechazo.
    const incompleto = [
      // DNI con FRONT presente (lo que el face-match usaría), pero faltan requeridos → el gate corta ANTES.
      dniWithFront,
      fleetDoc(FleetDocumentType.LICENSE_A1, FleetDocumentStatus.VALID),
      fleetDoc(FleetDocumentType.PROPERTY_CARD, FleetDocumentStatus.VALID),
      fleetDoc(FleetDocumentType.VEHICLE_PHOTO, FleetDocumentStatus.VALID),
    ];
    const fleetGrpc = grpc((m) =>
      m === 'GetDriverDocuments' ? { driverId: 'd1', documents: incompleto } : {},
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
      noopMaps,
      noopReadModel,
      noopAudit,
      config,
    );
    await expect(svc.runDniFaceMatch(identity, 'd1')).rejects.toBeInstanceOf(ConflictError);
    expect(identityPost).not.toHaveBeenCalled();
  });
});

describe('OpsService.runLicenseFaceMatch · orquesta el BINDING licencia↔selfie (Lote C)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Brevete (LICENSE_A1) con imagen FRONT — la cara del titular que el face-match usa. */
  const licenseWithFront = {
    id: 'doc-license',
    ownerType: 'DRIVER',
    ownerId: 'd1',
    type: FleetDocumentType.LICENSE_A1,
    documentNumber: 'Q12345678',
    status: FleetDocumentStatus.PENDING_REVIEW,
    expiresAt: '',
    fileS3Key: '',
    rejectionReason: '',
    images: [{ s3Key: 'drivers/d1/license-front.jpg', side: 'FRONT', order: 0 }],
  };

  it('baja la foto del brevete de S3, la pasa a identity y devuelve + audita el resultado', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([5, 6, 7, 8]), { status: 200 }),
    );
    // El brevete (LICENSE_A1) con su FRONT + los otros 3 requeridos SUBIDOS (gate de inicio de verificación #2).
    // No se usa allValidDocs para no duplicar el LICENSE_A1 (el find del face-match debe dar el que TIENE FRONT).
    const fleetGrpc = grpc((m) =>
      m === 'GetDriverDocuments'
        ? {
            driverId: 'd1',
            documents: [
              licenseWithFront,
              fleetDoc(FleetDocumentType.SOAT, FleetDocumentStatus.VALID),
              fleetDoc(FleetDocumentType.PROPERTY_CARD, FleetDocumentStatus.VALID),
              fleetDoc(FleetDocumentType.VEHICLE_PHOTO, FleetDocumentStatus.VALID),
            ],
          }
        : {},
    );
    const presignPost = vi.fn().mockResolvedValue({ url: 'https://signed/license-front' });
    const media = { post: presignPost } as unknown as InternalRestClient;
    const identityPost = vi.fn().mockResolvedValue({ matched: true, score: 88, reason: null });
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
      noopMaps,
      noopReadModel,
      audit,
      config,
    );

    const out = await svc.runLicenseFaceMatch(identity, 'd1');

    expect(out).toEqual({ matched: true, score: 88, reason: null });
    expect(presignPost.mock.calls[0]?.[1]?.body?.key).toBe('drivers/d1/license-front.jpg');
    expect(identityPost).toHaveBeenCalledWith(
      '/drivers/d1/license-face-match',
      expect.objectContaining({ body: { image: Buffer.from([5, 6, 7, 8]).toString('base64') } }),
    );
    expect(record).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({ action: 'driver.license-face-match' }),
    );
  });

  it('sin foto del brevete → 409 (ConflictError) sin llamar a identity', async () => {
    // Requeridos SUBIDOS (pasa el gate #2), pero el LICENSE_A1 no tiene imagen FRONT → falla en el lookup del
    // FRONT del brevete, no en el gate de presencia (así el test sigue ejercitando ese path específico).
    const fleetGrpc = grpc((m) =>
      m === 'GetDriverDocuments' ? { driverId: 'd1', documents: [...allValidDocs] } : {},
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
      noopMaps,
      noopReadModel,
      noopAudit,
      config,
    );
    await expect(svc.runLicenseFaceMatch(identity, 'd1')).rejects.toBeInstanceOf(ConflictError);
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
      noopMaps,
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
      noopMaps,
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
        noopMaps,
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
      noopMaps,
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
      noopMaps,
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
      noopMaps,
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
      noopMaps,
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

describe('OpsService.listDrivers · reconciliación del badge contra el suspendedAt autoritativo de identity', () => {
  afterEach(() => vi.clearAllMocks());

  /** read-model que devuelve los registros dados (status crudo del read-model). */
  function readModelWith(records: Record<string, unknown>[]): ReadModelService {
    return {
      listDrivers: vi.fn().mockResolvedValue({ items: records, nextCursor: null }),
    } as unknown as ReadModelService;
  }

  const rmDriver = (id: string, status: string) => ({
    id,
    userId: `u-${id}`,
    status,
    averageRating: null,
    backgroundCheckStatus: 'CLEARED',
    rejectionReason: null,
    updatedAt: '2026-06-20T00:00:00.000Z',
  });

  it('read-model SUSPENDED + identity LIBRE (auto-reactivación) → badge ACTIVE (gap [4] cerrado)', async () => {
    const identityGrpc = grpc((m) =>
      m === 'GetDriversByIds'
        ? {
            drivers: [
              { id: 'd1', name: 'Nora', phone: '+51900000000', suspendedAt: '', found: true },
            ],
          }
        : {},
    );
    const svc = new OpsService(
      grpc(() => ({})),
      identityGrpc,
      noopFleet,
      noopRest,
      noopMedia,
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
      noopMaps,
      readModelWith([rmDriver('d1', 'SUSPENDED')]),
      noopAudit,
      config,
    );

    const page = await svc.listDrivers(identity, {});
    // identity (autoridad) dice libre (suspendedAt "") → el badge stale del read-model se baja a ACTIVE.
    expect(page.items[0]?.status).toBe('ACTIVE');
  });

  it('read-model ACTIVE + identity SUSPENDIDO (ITV por userId, no proyectada) → badge SUSPENDED', async () => {
    const identityGrpc = grpc((m) =>
      m === 'GetDriversByIds'
        ? {
            drivers: [
              {
                id: 'd1',
                name: 'Nora',
                phone: '',
                suspendedAt: '2026-06-21T00:00:00.000Z',
                found: true,
              },
            ],
          }
        : {},
    );
    const svc = new OpsService(
      grpc(() => ({})),
      identityGrpc,
      noopFleet,
      noopRest,
      noopMedia,
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
      noopMaps,
      readModelWith([rmDriver('d1', 'ACTIVE')]),
      noopAudit,
      config,
    );

    const page = await svc.listDrivers(identity, {});
    expect(page.items[0]?.status).toBe('SUSPENDED');
  });

  it('reconcilia el badge AUNQUE el rol sea sub-Compliance (suspendedAt NO es PII), pero redacta nombre/teléfono', async () => {
    const support: AuthenticatedUser = { ...identity, roles: [AdminRole.SUPPORT_L1] };
    const grpcCall = vi.fn((m: string) =>
      Promise.resolve(
        m === 'GetDriversByIds'
          ? {
              drivers: [
                { id: 'd1', name: 'Nora', phone: '+51900000000', suspendedAt: '', found: true },
              ],
            }
          : {},
      ),
    );
    const identityGrpc = { call: grpcCall } as unknown as GrpcServiceClient;
    const svc = new OpsService(
      grpc(() => ({})),
      identityGrpc,
      noopFleet,
      noopRest,
      noopMedia,
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
      noopMaps,
      readModelWith([rmDriver('d1', 'SUSPENDED')]),
      noopAudit,
      config,
    );

    const page = await svc.listDrivers(support, {});
    // El badge se reconcilia para TODOS los roles (suspendedAt es estado, no PII)…
    expect(page.items[0]?.status).toBe('ACTIVE');
    // …pero la PII (nombre/teléfono) sigue redactada para sub-Compliance.
    expect(page.items[0]?.fullName).toBeNull();
    expect(page.items[0]?.phone).toBeNull();
    // Se consultó identity igual (para el badge), aunque el rol no vea PII.
    expect(grpcCall).toHaveBeenCalledWith('GetDriversByIds', expect.anything(), expect.anything());
  });

  it('FIX 2 · el batch trae las CAUSAS y la lista las propaga por fila (UI cause-aware end-to-end)', async () => {
    const identityGrpc = grpc((m) =>
      m === 'GetDriversByIds'
        ? {
            drivers: [
              {
                id: 'd1',
                name: 'Nora',
                phone: '+51900000000',
                suspendedAt: '2026-06-21T00:00:00.000Z',
                found: true,
                // El batch (FIX 2) ahora trae las causas distintas por driver, igual que el detalle.
                suspensionCauses: ['DOCUMENT_EXPIRED', 'DISCIPLINARY'],
              },
            ],
          }
        : {},
    );
    const svc = new OpsService(
      grpc(() => ({})),
      identityGrpc,
      noopFleet,
      noopRest,
      noopMedia,
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
      noopMaps,
      readModelWith([rmDriver('d1', 'SUSPENDED')]),
      noopAudit,
      config,
    );

    const page = await svc.listDrivers(identity, {});
    // La fila de la LISTA expone las causas → el panel ofrece la acción de reactivación correcta sin abrir el detalle.
    expect(page.items[0]?.suspensionCauses).toEqual(['DOCUMENT_EXPIRED', 'DISCIPLINARY']);
  });

  it('FIX 2 · causa desconocida del wire (productor más nuevo) se DESCARTA — nunca se inventa una acción', async () => {
    const identityGrpc = grpc((m) =>
      m === 'GetDriversByIds'
        ? {
            drivers: [
              {
                id: 'd1',
                name: 'Nora',
                phone: '+51900000000',
                suspendedAt: '2026-06-21T00:00:00.000Z',
                found: true,
                // 'FUTURE_CAUSE' aún no existe en este BFF → se filtra; la conocida se conserva.
                suspensionCauses: ['DISCIPLINARY', 'FUTURE_CAUSE'],
              },
            ],
          }
        : {},
    );
    const svc = new OpsService(
      grpc(() => ({})),
      identityGrpc,
      noopFleet,
      noopRest,
      noopMedia,
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
      noopMaps,
      readModelWith([rmDriver('d1', 'SUSPENDED')]),
      noopAudit,
      config,
    );

    const page = await svc.listDrivers(identity, {});
    expect(page.items[0]?.suspensionCauses).toEqual(['DISCIPLINARY']);
  });
});

describe('OpsService.reactivateDriverForCompliance · override manual (compliance holds) — UNA escritura', () => {
  afterEach(() => vi.clearAllMocks());

  it('UNA escritura autoritativa: levanta los holds de compliance en identity y audita, SIN tocar fleet', async () => {
    const identityPost = vi.fn().mockResolvedValue(undefined);
    // fleet NO debe tocarse: el latch fue eliminado con el refactor a holds → cero segundo paso cross-service.
    const fleetPost = vi.fn();
    const identityRest = { post: identityPost } as unknown as InternalRestClient;
    const fleetRest = { post: fleetPost } as unknown as InternalRestClient;
    const record = vi.fn().mockResolvedValue({ id: 'a', seq: '1', hash: 'h' });
    const audit = { record } as unknown as AuditRecorder;
    const svc = new OpsService(
      grpc(() => ({})),
      identityGrpcWithDriver,
      noopFleet,
      identityRest,
      noopMedia,
      noopTripRest,
      fleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
      noopMaps,
      noopReadModel,
      audit,
      config,
    );

    await svc.reactivateDriverForCompliance(identity, 'd1');

    // Levanta los holds DOCUMENT_EXPIRED + INSPECTION_EXPIRED en identity (source of truth, UNA tx).
    expect(identityPost).toHaveBeenCalledWith('/drivers/d1/reactivate-compliance', { identity });
    // SIN segundo paso cross-service: el latch ya no existe → fleet no se toca (override atómico).
    expect(fleetPost).not.toHaveBeenCalled();
    // Audita la acción específica del override (distinta de la reactivación disciplinaria), sin flags de latch.
    expect(record).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({
        action: 'driver.reactivate-compliance',
        resourceId: 'd1',
      }),
    );
  });

  it('FAIL-CLOSED: si identity rechaza (403), el error sube y NO se audita', async () => {
    const forbidden = new ForbiddenError('no es de compliance');
    const identityPost = vi.fn().mockRejectedValue(forbidden);
    const record = vi.fn();
    const svc = new OpsService(
      grpc(() => ({})),
      identityGrpcWithDriver,
      noopFleet,
      { post: identityPost } as unknown as InternalRestClient,
      noopMedia,
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
      noopMaps,
      noopReadModel,
      { record } as unknown as AuditRecorder,
      config,
    );

    await expect(svc.reactivateDriverForCompliance(identity, 'd1')).rejects.toBe(forbidden);
    expect(record).not.toHaveBeenCalled(); // el levantamiento falló → no se audita.
  });
});

describe('OpsService.unlockBiometric · destrabe biométrico por la central (F3)', () => {
  it('llama a identity (POST /biometric/unlock) y AUDITA el comando del operador', async () => {
    const identityPost = vi.fn().mockResolvedValue(undefined);
    const identityRest = { post: identityPost } as unknown as InternalRestClient;
    const record = vi.fn().mockResolvedValue({ id: 'a', seq: '1', hash: 'h' });
    const audit = { record } as unknown as AuditRecorder;
    const svc = new OpsService(
      grpc(() => ({})),
      grpc(() => ({})),
      grpc(() => ({})),
      identityRest,
      noopMedia,
      noopTripRest,
      noopFleetRest,
      noopPaymentRest,
      InternalAudience.ADMIN_RAIL,
      noopMaps,
      noopReadModel,
      audit,
      config,
    );
    await svc.unlockBiometric(identity, 'd1');
    expect(identityPost).toHaveBeenCalledWith(
      '/drivers/d1/biometric/unlock',
      expect.objectContaining({ identity }),
    );
    expect(record).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({ action: 'driver.biometric-unlock', resourceId: 'd1' }),
    );
  });
});

/** Detalle CRUDO de un operador tal como lo devuelve identity (GET /admin/operators/:id). */
function rawOperatorDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'op-1',
    email: 'op@veo.pe',
    name: 'Op Uno',
    status: 'ACTIVE',
    roles: ['ADMIN'],
    totpEnrolled: true,
    lastLoginAt: '2026-07-01T00:00:00.000Z',
    createdAt: '2026-06-01T00:00:00.000Z',
    sessions: [{ id: 'sess-1', lastActiveAt: '2026-07-05T00:00:00.000Z' }],
    ...overrides,
  };
}

/** Ensambla un OpsService con SOLO el identityRest + audit cableados (el resto noop) — casos de operadores. */
function opsForOperators(rest: InternalRestClient, audit: AuditRecorder): OpsService {
  return new OpsService(
    grpc(() => ({})),
    grpc(() => ({})),
    noopFleet,
    rest,
    noopMedia,
    noopTripRest,
    noopFleetRest,
    noopPaymentRest,
    InternalAudience.ADMIN_RAIL,
    noopMaps,
    noopReadModel,
    audit,
    config,
  );
}

describe('OpsService.operatorDetail · deriva effectivePermissions de los roles (matriz base @veo/policy)', () => {
  it('FINANCE: effectivePermissions INCLUYE finance:view y EXCLUYE trips:view; conserva 2FA/último acceso/sesiones', async () => {
    const get = vi.fn().mockResolvedValue(rawOperatorDetail({ roles: ['FINANCE'] }));
    const rest = { get } as unknown as InternalRestClient;
    const svc = opsForOperators(rest, noopAudit);

    const detail = await svc.operatorDetail(identity, 'op-1');

    expect(get).toHaveBeenCalledWith('/admin/operators/op-1', { identity });
    // BASE (per-target): FINANCE concede finance:view, NO trips:view.
    expect(detail.effectivePermissions).toContain('finance:view');
    expect(detail.effectivePermissions).not.toContain('trips:view');
    // Los tres campos de la fila + sesiones fluyen tal cual.
    expect(detail.totpEnrolled).toBe(true);
    expect(detail.lastLoginAt).toBe('2026-07-01T00:00:00.000Z');
    expect(detail.name).toBe('Op Uno');
    expect(detail.sessions).toEqual([{ id: 'sess-1', lastActiveAt: '2026-07-05T00:00:00.000Z' }]);
  });
});

describe('OpsService · mutaciones de operador (gate anti-escalada + propaga + audita)', () => {
  it('changeOperatorRoles ADMIN → [SUPERADMIN]: ForbiddenError CORTA antes del REST', async () => {
    const post = vi.fn();
    const record = vi.fn();
    const svc = opsForOperators(
      { post } as unknown as InternalRestClient,
      { record } as unknown as AuditRecorder,
    );
    await expect(
      svc.changeOperatorRoles(identity, 'op-1', [AdminRole.SUPERADMIN]),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(post).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('changeOperatorRoles ADMIN → [SUPPORT_L2]: propaga al REST, audita y recomputa effectivePermissions', async () => {
    const post = vi.fn().mockResolvedValue(rawOperatorDetail({ roles: ['SUPPORT_L2'] }));
    const record = vi.fn().mockResolvedValue({ id: 'a', seq: '1', hash: 'h' });
    const svc = opsForOperators(
      { post } as unknown as InternalRestClient,
      { record } as unknown as AuditRecorder,
    );

    const out = await svc.changeOperatorRoles(identity, 'op-1', [AdminRole.SUPPORT_L2]);

    expect(post).toHaveBeenCalledWith('/admin/operators/op-1/roles', {
      identity,
      body: { roles: [AdminRole.SUPPORT_L2] },
    });
    expect(record).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({ action: 'operator.role_change', resourceId: 'op-1' }),
    );
    expect(out.roles).toEqual(['SUPPORT_L2']);
    // SUPPORT_L2 concede trips:view en la base → aparece en effectivePermissions recomputado.
    expect(out.effectivePermissions).toContain('trips:view');
  });

  it('suspendOperator: propaga POST suspend y audita', async () => {
    const post = vi.fn().mockResolvedValue({});
    const record = vi.fn().mockResolvedValue({ id: 'a', seq: '1', hash: 'h' });
    const svc = opsForOperators(
      { post } as unknown as InternalRestClient,
      { record } as unknown as AuditRecorder,
    );
    await svc.suspendOperator(identity, 'op-1');
    expect(post).toHaveBeenCalledWith('/admin/operators/op-1/suspend', { identity });
    expect(record).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({ action: 'operator.suspend', resourceId: 'op-1' }),
    );
  });

  it('removeOperator: propaga POST remove y audita', async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const record = vi.fn().mockResolvedValue({ id: 'a', seq: '1', hash: 'h' });
    const svc = opsForOperators(
      { post } as unknown as InternalRestClient,
      { record } as unknown as AuditRecorder,
    );
    await svc.removeOperator(identity, 'op-1');
    expect(post).toHaveBeenCalledWith('/admin/operators/op-1/remove', { identity });
    expect(record).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({ action: 'operator.remove', resourceId: 'op-1' }),
    );
  });

  it('revokeOperatorSession: propaga POST del sid y audita con el sessionId', async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const record = vi.fn().mockResolvedValue({ id: 'a', seq: '1', hash: 'h' });
    const svc = opsForOperators(
      { post } as unknown as InternalRestClient,
      { record } as unknown as AuditRecorder,
    );
    await svc.revokeOperatorSession(identity, 'op-1', 'sess-1');
    expect(post).toHaveBeenCalledWith('/admin/operators/op-1/sessions/sess-1/revoke', { identity });
    expect(record).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({
        action: 'operator.session.revoke',
        resourceId: 'op-1',
        payload: { sessionId: 'sess-1' },
      }),
    );
  });
});
