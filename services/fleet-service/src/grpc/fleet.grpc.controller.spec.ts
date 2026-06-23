/**
 * Spec del controlador gRPC de fleet — foco en GetDriverInspectionStatus (gate de aprobación · ITV).
 * La REGLA: el vehículo OPERADO del conductor (pickActiveVehicle) debe tener su última inspección VIGENTE
 * (passed && nextDueAt > now). Sin vehículo operable → NO_VEHICLE. La metadata se firma de verdad (mismo
 * patrón que identity.grpc.controller.spec): no se mockea @veo/auth.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Metadata } from '@grpc/grpc-js';
import {
  grpcIdentityMetadata,
  InternalAudience,
  type AuthenticatedUser,
} from '@veo/auth';
import { FleetGrpcController } from './fleet.grpc.controller';
import type { PrismaService } from '../infra/prisma.service';
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
  const headers = grpcIdentityMetadata(ADMIN, INTERNAL_IDENTITY_SECRET, InternalAudience.ADMIN_RAIL);
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
  };
}

/** Inspection mínima (passed + nextDueAt) — la última del vehículo operado. */
function inspection(passed: boolean, nextDueAt: string): Record<string, unknown> {
  return { id: 'insp-1', passed, nextDueAt: new Date(nextDueAt) };
}

function makeController(opts: {
  vehicles?: unknown[];
  latestInspection?: unknown;
}): FleetGrpcController {
  const prisma = {
    read: {
      vehicle: { findMany: vi.fn(() => Promise.resolve(opts.vehicles ?? [])) },
      inspection: {
        findFirst: vi.fn(() => Promise.resolve(opts.latestInspection ?? null)),
      },
    },
  } as unknown as PrismaService;
  const config = new ConfigService<Env, true>({ INTERNAL_IDENTITY_SECRET } as Env);
  return new FleetGrpcController(prisma, config, [InternalAudience.ADMIN_RAIL]);
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
      vehicle({ id: 'veh-old', plate: 'OLD-111', selectedAt: new Date('2026-01-01T00:00:00.000Z') }),
      vehicle({ id: 'veh-new', plate: 'NEW-222', selectedAt: new Date('2026-06-01T00:00:00.000Z') }),
    ];
    const findFirst = vi.fn(() => Promise.resolve(inspection(true, '2099-01-01T00:00:00.000Z')));
    const prisma = {
      read: {
        vehicle: { findMany: vi.fn(() => Promise.resolve(vehicles)) },
        inspection: { findFirst },
      },
    } as unknown as PrismaService;
    const config = new ConfigService<Env, true>({ INTERNAL_IDENTITY_SECRET } as Env);
    const ctrl = new FleetGrpcController(prisma, config, [InternalAudience.ADMIN_RAIL]);

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
        vehicle({ id: 'veh-old', plate: 'OLD-111', selectedAt: new Date('2026-01-01T00:00:00.000Z') }),
        vehicle({ id: 'veh-new', plate: 'NEW-222', selectedAt: new Date('2026-06-01T00:00:00.000Z') }),
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
    await expect(
      ctrl.getDriverActiveVehicle({ id: 'u1' }, new Metadata()),
    ).rejects.toBeDefined();
  });
});
