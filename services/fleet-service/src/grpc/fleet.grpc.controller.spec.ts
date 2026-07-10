/**
 * Spec del controlador gRPC de fleet — foco en GetDriverInspectionStatus (gate de aprobación · ITV).
 * La REGLA: el vehículo OPERADO del conductor (pickActiveVehicle) debe tener su última inspección VIGENTE
 * (passed && nextDueAt > now). Sin vehículo operable → NO_VEHICLE. La metadata se firma de verdad (mismo
 * patrón que identity.grpc.controller.spec): no se mockea @veo/auth.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Metadata } from '@grpc/grpc-js';
import { grpcIdentityMetadata, InternalAudience, type AuthenticatedUser } from '@veo/auth';
import { FleetGrpcController } from './fleet.grpc.controller';
import type { PrismaService } from '../infra/prisma.service';
import { PrismaFleetGrpcRepository } from './fleet-grpc.repository';
import type { Env } from '../config/env.schema';

const INTERNAL_IDENTITY_SECRET = 's'.repeat(32);

const ADMIN: AuthenticatedUser = {
  userId: 'op-1',
  type: 'admin',
  roles: ['ADMIN'],
  sessionId: 'sess-1',
};

/** Metadata gRPC entrante FIRMADA (admin-rail) con el mismo secret que el controller. */
function signedMeta(): Metadata {
  const meta = new Metadata();
  const headers = grpcIdentityMetadata(
    ADMIN,
    INTERNAL_IDENTITY_SECRET,
    InternalAudience.ADMIN_RAIL,
  );
  for (const [k, v] of Object.entries(headers)) meta.set(k, v);
  return meta;
}

/** Vehicle mínimo con los campos que pickActiveVehicle + el reply necesitan. */
function vehicle(
  overrides: Partial<{
    id: string;
    plate: string;
    docStatus: string;
    selectedAt: Date | null;
    createdAt: Date;
    modelSpecId: string | null;
  }> = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? 'veh-1',
    plate: overrides.plate ?? 'ABC-123',
    make: 'Toyota',
    model: 'Yaris',
    year: 2021,
    color: 'Plata',
    vehicleType: 'CAR',
    docStatus: overrides.docStatus ?? 'VALID',
    active: true,
    selectedAt: overrides.selectedAt ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-01-01T00:00:00.000Z'),
    modelSpecId: overrides.modelSpecId ?? null,
  };
}

/** Documento de vehículo (ownerType=VEHICLE) para alimentar el cómputo de docsOperable (SOAT+ITV). */
function vehicleDoc(ownerId: string, type: string, status: string): Record<string, unknown> {
  return { ownerType: 'VEHICLE', ownerId, type, status };
}

/** Inspection mínima (passed + nextDueAt) — la última del vehículo operado. */
function inspection(passed: boolean, nextDueAt: string): Record<string, unknown> {
  return { id: 'insp-1', passed, nextDueAt: new Date(nextDueAt) };
}

function makeController(opts: {
  vehicles?: unknown[];
  latestInspection?: unknown;
  vehicleDocs?: unknown[];
}): FleetGrpcController {
  const makeClient = () => ({
    vehicle: {
      findMany: vi.fn(() => Promise.resolve(opts.vehicles ?? [])),
      findUnique: vi.fn(() => Promise.resolve((opts.vehicles ?? [])[0] ?? null)),
    },
    inspection: {
      findFirst: vi.fn(() => Promise.resolve(opts.latestInspection ?? null)),
    },
    // Docs requeridos del vehículo (ownerType=VEHICLE) para el cómputo de docsOperable (SOAT+ITV).
    fleetDocument: { findMany: vi.fn(() => Promise.resolve(opts.vehicleDocs ?? [])) },
  });
  // `write` = PRIMARY (lo usa el gate de dinero GetVehicle), `read` = RÉPLICA (display/batch). Mismos stubs.
  const prisma = {
    read: makeClient(),
    write: makeClient(),
  } as unknown as PrismaService;
  const config = new ConfigService<Env, true>({ INTERNAL_IDENTITY_SECRET } as Env);
  return new FleetGrpcController(new PrismaFleetGrpcRepository(prisma),  config, [InternalAudience.ADMIN_RAIL]);
}

describe('FleetGrpcController.getDriverInspectionStatus (gate de aprobación · ITV)', () => {
  it('VIGENTE: vehículo operado con última inspección passed && no vencida → current=true', async () => {
    const ctrl = makeController({
      vehicles: [vehicle()],
      latestInspection: inspection(true, '2099-01-01T00:00:00.000Z'),
    });
    const out = await ctrl.getDriverInspectionStatus({ id: 'u1' }, signedMeta());
    expect(out.current).toBe(true);
    expect(out.hasVehicle).toBe(true);
    expect(out.vehicleId).toBe('veh-1');
    expect(out.plate).toBe('ABC-123');
    expect(out.passed).toBe(true);
    expect(out.invalidReason).toBe('');
  });

  it('VENCIDA: última inspección passed pero nextDueAt en el pasado → current=false, OVERDUE', async () => {
    const ctrl = makeController({
      vehicles: [vehicle()],
      latestInspection: inspection(true, '2000-01-01T00:00:00.000Z'),
    });
    const out = await ctrl.getDriverInspectionStatus({ id: 'u1' }, signedMeta());
    expect(out.current).toBe(false);
    expect(out.invalidReason).toBe('OVERDUE');
    expect(out.passed).toBe(true);
  });

  it('REPROBADA: última inspección passed=false (aunque no vencida) → current=false, NOT_PASSED', async () => {
    const ctrl = makeController({
      vehicles: [vehicle()],
      latestInspection: inspection(false, '2099-01-01T00:00:00.000Z'),
    });
    const out = await ctrl.getDriverInspectionStatus({ id: 'u1' }, signedMeta());
    expect(out.current).toBe(false);
    expect(out.invalidReason).toBe('NOT_PASSED');
    expect(out.passed).toBe(false);
  });

  it('SIN INSPECCIÓN: vehículo operado pero ninguna inspección → current=false, NONE', async () => {
    const ctrl = makeController({ vehicles: [vehicle()], latestInspection: null });
    const out = await ctrl.getDriverInspectionStatus({ id: 'u1' }, signedMeta());
    expect(out.current).toBe(false);
    expect(out.hasVehicle).toBe(true);
    expect(out.invalidReason).toBe('NONE');
    expect(out.nextDueAt).toBe('');
  });

  it('SIN VEHÍCULO: el conductor no tiene vehículos → current=false, NO_VEHICLE, hasVehicle=false', async () => {
    const ctrl = makeController({ vehicles: [] });
    const out = await ctrl.getDriverInspectionStatus({ id: 'u1' }, signedMeta());
    expect(out.current).toBe(false);
    expect(out.hasVehicle).toBe(false);
    expect(out.vehicleId).toBe('');
    expect(out.invalidReason).toBe('NO_VEHICLE');
  });

  it('evalúa el vehículo OPERADO (pickActiveVehicle): el de selectedAt más reciente, NO otro', async () => {
    // veh-old seleccionado antes; veh-new seleccionado después → opera veh-new. La inspección VIGENTE
    // se consulta SOBRE veh-new (findFirst recibe su id). Un solo doble de inspección igual basta para
    // verificar que el vehicleId resuelto es el operado.
    const vehicles = [
      vehicle({
        id: 'veh-old',
        plate: 'OLD-111',
        selectedAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
      vehicle({
        id: 'veh-new',
        plate: 'NEW-222',
        selectedAt: new Date('2026-06-01T00:00:00.000Z'),
      }),
    ];
    const findFirst = vi.fn(() => Promise.resolve(inspection(true, '2099-01-01T00:00:00.000Z')));
    const prisma = {
      read: {
        vehicle: { findMany: vi.fn(() => Promise.resolve(vehicles)) },
        inspection: { findFirst },
      },
    } as unknown as PrismaService;
    const config = new ConfigService<Env, true>({ INTERNAL_IDENTITY_SECRET } as Env);
    const ctrl = new FleetGrpcController(new PrismaFleetGrpcRepository(prisma),  config, [InternalAudience.ADMIN_RAIL]);

    const out = await ctrl.getDriverInspectionStatus({ id: 'u1' }, signedMeta());
    expect(out.vehicleId).toBe('veh-new');
    expect(out.plate).toBe('NEW-222');
    // La inspección se consultó SOBRE el vehículo operado (veh-new), no sobre el viejo.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { vehicleId: 'veh-new' } }),
    );
  });

  it('rechaza (UNAUTHENTICATED) si la metadata no trae identidad firmada', async () => {
    const ctrl = makeController({ vehicles: [vehicle()] });
    await expect(
      ctrl.getDriverInspectionStatus({ id: 'u1' }, new Metadata()),
    ).rejects.toBeDefined();
  });
});

describe('FleetGrpcController.getDriverActiveVehicle (FUENTE ÚNICA del vehículo operado)', () => {
  it('resuelve el MISMO vehículo operado que el gate (pickActiveVehicle: selectedAt más reciente)', async () => {
    // veh-new seleccionado después que veh-old → opera veh-new. El selector autoritativo único es el
    // mismo `pickActiveVehicle` que usa getDriverInspectionStatus; dispatch consume ESTE RPC en vez de
    // re-derivar con `.find(active)`. Así el vehicleId del viaje NO diverge del que valida el gate de ITV.
    const ctrl = makeController({
      vehicles: [
        vehicle({
          id: 'veh-old',
          plate: 'OLD-111',
          selectedAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
        vehicle({
          id: 'veh-new',
          plate: 'NEW-222',
          selectedAt: new Date('2026-06-01T00:00:00.000Z'),
        }),
      ],
    });
    const out = await ctrl.getDriverActiveVehicle({ id: 'u1' }, signedMeta());
    expect(out.found).toBe(true);
    expect(out.id).toBe('veh-new');
    expect(out.plate).toBe('NEW-222');
  });

  it('found=false si el conductor no tiene ningún vehículo operable', async () => {
    const ctrl = makeController({ vehicles: [] });
    const out = await ctrl.getDriverActiveVehicle({ id: 'u1' }, signedMeta());
    expect(out.found).toBe(false);
    expect(out.id).toBe('');
  });

  it('found=false si todos los vehículos tienen docs vencidos (no operable)', async () => {
    const ctrl = makeController({
      vehicles: [vehicle({ id: 'veh-x', docStatus: 'EXPIRED' })],
    });
    const out = await ctrl.getDriverActiveVehicle({ id: 'u1' }, signedMeta());
    expect(out.found).toBe(false);
  });

  it('rechaza (UNAUTHENTICATED) sin identidad firmada', async () => {
    const ctrl = makeController({ vehicles: [vehicle()] });
    await expect(ctrl.getDriverActiveVehicle({ id: 'u1' }, new Metadata())).rejects.toBeDefined();
  });
});

/**
 * Operabilidad money-safety: el reply (`active`/`status`) deriva de los docs REQUERIDOS del vehículo
 * (SOAT+ITV ownerType=VEHICLE, presentes+aprobados+vigentes) Y la ficha linkeada (modelSpecId). Un vehículo
 * SIN esos docs NUNCA debe derivar a ACTIVE — ese es el punto de la corrección.
 */
describe('FleetGrpcController · operabilidad derivada de los docs del vehículo (SOAT+ITV)', () => {
  it('GetDriverActiveVehicle: SOAT+ITV VALID + ficha → active=true, status=ACTIVE', async () => {
    const ctrl = makeController({
      vehicles: [vehicle({ id: 'veh-1', modelSpecId: 'spec-1' })],
      vehicleDocs: [vehicleDoc('veh-1', 'SOAT', 'VALID'), vehicleDoc('veh-1', 'ITV', 'VALID')],
    });
    const out = await ctrl.getDriverActiveVehicle({ id: 'u1' }, signedMeta());
    expect(out.found).toBe(true);
    expect(out.active).toBe(true);
    expect(out.status).toBe('ACTIVE');
  });

  it('GetDriverActiveVehicle: SIN docs requeridos → active=false, status=PENDING_REVIEW (aunque tenga ficha)', async () => {
    const ctrl = makeController({
      vehicles: [vehicle({ id: 'veh-1', modelSpecId: 'spec-1' })],
      vehicleDocs: [],
    });
    const out = await ctrl.getDriverActiveVehicle({ id: 'u1' }, signedMeta());
    expect(out.found).toBe(true);
    expect(out.active).toBe(false);
    expect(out.status).toBe('PENDING_REVIEW');
  });

  it('GetDriverActiveVehicle: SOAT VALID pero ITV EXPIRED → active=false (no opera con ITV vencida)', async () => {
    const ctrl = makeController({
      vehicles: [vehicle({ id: 'veh-1', modelSpecId: 'spec-1' })],
      vehicleDocs: [vehicleDoc('veh-1', 'SOAT', 'VALID'), vehicleDoc('veh-1', 'ITV', 'EXPIRED')],
    });
    const out = await ctrl.getDriverActiveVehicle({ id: 'u1' }, signedMeta());
    expect(out.active).toBe(false);
    expect(out.status).toBe('PENDING_REVIEW');
  });

  it('GetDriverActiveVehicle: SOAT+ITV VALID pero SIN ficha (modelSpecId null) → active=false', async () => {
    const ctrl = makeController({
      vehicles: [vehicle({ id: 'veh-1', modelSpecId: null })],
      vehicleDocs: [vehicleDoc('veh-1', 'SOAT', 'VALID'), vehicleDoc('veh-1', 'ITV', 'VALID')],
    });
    const out = await ctrl.getDriverActiveVehicle({ id: 'u1' }, signedMeta());
    expect(out.active).toBe(false);
    expect(out.status).toBe('PENDING_REVIEW');
  });

  it('GetVehicle: SOAT+ITV VALID + ficha → active=true, status=ACTIVE', async () => {
    const ctrl = makeController({
      vehicles: [vehicle({ id: 'veh-1', modelSpecId: 'spec-1' })],
      vehicleDocs: [vehicleDoc('veh-1', 'SOAT', 'VALID'), vehicleDoc('veh-1', 'ITV', 'VALID')],
    });
    const out = await ctrl.getVehicle({ id: 'veh-1' }, signedMeta());
    expect(out.found).toBe(true);
    expect(out.active).toBe(true);
    expect(out.status).toBe('ACTIVE');
  });

  it('GetDriverVehicles: batchea los docs y deriva la operabilidad por vehículo (anti-N+1)', async () => {
    // veh-1 operable (SOAT+ITV VALID + ficha) ; veh-2 sin docs → PENDING_REVIEW. UNA sola query de docs.
    const docsFindMany = vi.fn(() =>
      Promise.resolve([vehicleDoc('veh-1', 'SOAT', 'VALID'), vehicleDoc('veh-1', 'ITV', 'VALID')]),
    );
    const vehicles = [
      vehicle({ id: 'veh-1', plate: 'AAA-111', modelSpecId: 'spec-1' }),
      vehicle({ id: 'veh-2', plate: 'BBB-222', modelSpecId: 'spec-2' }),
    ];
    const prisma = {
      read: {
        vehicle: { findMany: vi.fn(() => Promise.resolve(vehicles)) },
        fleetDocument: { findMany: docsFindMany },
      },
    } as unknown as PrismaService;
    const config = new ConfigService<Env, true>({ INTERNAL_IDENTITY_SECRET } as Env);
    const ctrl = new FleetGrpcController(new PrismaFleetGrpcRepository(prisma),  config, [InternalAudience.ADMIN_RAIL]);

    const out = await ctrl.getDriverVehicles({ id: 'u1' }, signedMeta());
    // UNA sola query de docs para toda la flota (no una por vehículo).
    expect(docsFindMany).toHaveBeenCalledTimes(1);
    const v1 = out.vehicles.find((v) => v.id === 'veh-1');
    const v2 = out.vehicles.find((v) => v.id === 'veh-2');
    expect(v1?.active).toBe(true);
    expect(v1?.status).toBe('ACTIVE');
    expect(v2?.active).toBe(false);
    expect(v2?.status).toBe('PENDING_REVIEW');
  });

  it('GetVehiclesByIds (Lote 3b): batch por ids, deriva operabilidad por vehículo, UNA query de docs (anti-N+1)', async () => {
    // veh-1 operable (SOAT+ITV VALID + ficha) ; veh-2 sin docs → PENDING_REVIEW. UNA sola query de docs batched.
    const docsFindMany = vi.fn(() =>
      Promise.resolve([vehicleDoc('veh-1', 'SOAT', 'VALID'), vehicleDoc('veh-1', 'ITV', 'VALID')]),
    );
    const vehiclesFindMany = vi.fn(() =>
      Promise.resolve([
        vehicle({ id: 'veh-1', plate: 'AAA-111', modelSpecId: 'spec-1' }),
        vehicle({ id: 'veh-2', plate: 'BBB-222', modelSpecId: 'spec-2' }),
      ]),
    );
    const prisma = {
      read: {
        vehicle: { findMany: vehiclesFindMany },
        fleetDocument: { findMany: docsFindMany },
      },
    } as unknown as PrismaService;
    const config = new ConfigService<Env, true>({ INTERNAL_IDENTITY_SECRET } as Env);
    const ctrl = new FleetGrpcController(new PrismaFleetGrpcRepository(prisma),  config, [InternalAudience.ADMIN_RAIL]);

    const out = await ctrl.getVehiclesByIds({ ids: ['veh-1', 'veh-2', 'veh-1'] }, signedMeta());
    // UNA query de vehículos + UNA de docs (anti-N+1), pese a los 3 ids (deduplica).
    expect(vehiclesFindMany).toHaveBeenCalledTimes(1);
    expect(docsFindMany).toHaveBeenCalledTimes(1);
    const v1 = out.vehicles.find((v) => v.id === 'veh-1');
    const v2 = out.vehicles.find((v) => v.id === 'veh-2');
    expect(v1?.active).toBe(true);
    expect(v1?.status).toBe('ACTIVE');
    expect(v2?.active).toBe(false);
    expect(v2?.status).toBe('PENDING_REVIEW');
  });

  it('GetVehiclesByIds (Lote 3b): ids vacío → reply vacío sin tocar la DB', async () => {
    const vehiclesFindMany = vi.fn(() => Promise.resolve([]));
    const prisma = {
      read: {
        vehicle: { findMany: vehiclesFindMany },
        fleetDocument: { findMany: vi.fn(() => Promise.resolve([])) },
      },
    } as unknown as PrismaService;
    const config = new ConfigService<Env, true>({ INTERNAL_IDENTITY_SECRET } as Env);
    const ctrl = new FleetGrpcController(new PrismaFleetGrpcRepository(prisma),  config, [InternalAudience.ADMIN_RAIL]);

    const out = await ctrl.getVehiclesByIds({ ids: [] }, signedMeta());
    expect(out.vehicles).toEqual([]);
    expect(vehiclesFindMany).not.toHaveBeenCalled();
  });
});
