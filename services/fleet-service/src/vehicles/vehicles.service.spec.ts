/**
 * VehiclesService.registerForDriver — la resolución de marca/modelo del alta (B5-2.b).
 * Lo crítico: si el conductor eligió un modelo del CATÁLOGO (modelSpecId), make/model/vehicleType salen
 * del spec APPROVED (server-authoritative, ignora el texto libre); un spec inexistente/no-aprobado se
 * rechaza; sin modelSpecId cae al texto libre y exige make+model.
 */
import { describe, it, expect, vi } from 'vitest';
import { ValidationError } from '@veo/utils';
import { VehicleType as SharedVehicleType } from '@veo/shared-types';
import { VehicleDocStatus, VehicleModelStatus, VehicleType, type Vehicle } from '../generated/prisma';
import { VehiclesService } from './vehicles.service';

function specRow(over: Record<string, unknown> = {}) {
  return {
    id: 'spec-1',
    make: 'Toyota',
    model: 'Yaris',
    yearFrom: 2017,
    yearTo: 2024,
    vehicleType: VehicleType.CAR,
    seats: 5,
    segment: 'ECONOMY',
    energySource: 'GASOLINE_95',
    efficiency: 17,
    status: VehicleModelStatus.APPROVED,
    requestedBy: null,
    verifiedBy: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

/** Doble de prisma: captura la data del create y la devuelve como Vehicle completo. */
function makeService(opts: { spec?: ReturnType<typeof specRow> | null } = {}) {
  const created: { data?: Record<string, unknown> } = {};
  const txCreate = vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
    created.data = data;
    const vehicle = {
      ...data,
      fleetId: null,
      insuranceExpiresAt: null,
      docStatus: VehicleDocStatus.VALID,
      selectedAt: null,
      createdAt: new Date('2026-06-16T00:00:00Z'),
      updatedAt: new Date('2026-06-16T00:00:00Z'),
    } as unknown as Vehicle;
    return Promise.resolve(vehicle);
  });
  const tx = { vehicle: { create: txCreate }, outboxEvent: { create: vi.fn().mockResolvedValue({}) } };

  const findFirst = vi.fn().mockResolvedValue(opts.spec ?? null);
  const prisma = {
    read: {
      vehicle: {
        findUnique: vi.fn().mockResolvedValue(null), // no duplicado de placa
        findMany: vi.fn().mockImplementation(() => Promise.resolve(created.data ? [created.data] : [])),
      },
      vehicleModelSpec: { findFirst },
    },
    write: { $transaction: (fn: (t: typeof tx) => unknown) => Promise.resolve(fn(tx)) },
  };
  const config = { getOrThrow: () => 2017 };
  const service = new VehiclesService(prisma as never, config as never);
  return { service, created, findFirst, txCreate };
}

const baseBody = { plate: 'ABC-123', year: 2022, vehicleType: SharedVehicleType.MOTO };

describe('VehiclesService.registerForDriver · B5-2 modelSpecId', () => {
  it('CON modelSpecId APPROVED: snapshot make/model/vehicleType del spec (ignora texto libre)', async () => {
    const { service, created, findFirst } = makeService({ spec: specRow() });
    await service.registerForDriver('driver-1', {
      ...baseBody,
      modelSpecId: 'spec-1',
      make: 'BASURA',
      model: 'IGNORADA',
    });
    // el spec gana: Toyota Yaris CAR, y guarda el modelSpecId
    expect(created.data?.make).toBe('Toyota');
    expect(created.data?.model).toBe('Yaris');
    expect(created.data?.vehicleType).toBe(VehicleType.CAR);
    expect(created.data?.modelSpecId).toBe('spec-1');
    // el where del catálogo exige APPROVED
    expect(findFirst.mock.calls[0]![0].where.status).toBe(VehicleModelStatus.APPROVED);
  });

  it('modelSpecId inexistente/no-aprobado → ValidationError (no crea)', async () => {
    const { service, txCreate } = makeService({ spec: null });
    await expect(
      service.registerForDriver('driver-1', { ...baseBody, modelSpecId: 'spec-x' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(txCreate).not.toHaveBeenCalled();
  });

  it('SIN modelSpecId: texto libre, modelSpecId queda null', async () => {
    const { service, created } = makeService();
    await service.registerForDriver('driver-1', { ...baseBody, make: 'Honda', model: 'CG 150' });
    expect(created.data?.make).toBe('Honda');
    expect(created.data?.model).toBe('CG 150');
    expect(created.data?.vehicleType).toBe(SharedVehicleType.MOTO);
    expect(created.data?.modelSpecId).toBeNull();
  });

  it('SIN modelSpecId y SIN make/model → ValidationError', async () => {
    const { service } = makeService();
    await expect(service.registerForDriver('driver-1', { ...baseBody })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

/** Vehículo completo de prueba para getActiveVehicle (campos que pickActiveVehicle/toResponse necesitan). */
function vehicleRow(over: Partial<Vehicle> = {}): Vehicle {
  return {
    id: 'v1',
    plate: 'ABC-123',
    make: 'Toyota',
    model: 'Yaris',
    year: 2022,
    color: 'Plata',
    vehicleType: VehicleType.CAR,
    fleetId: null,
    driverId: 'driver-1',
    docStatus: VehicleDocStatus.VALID,
    insuranceExpiresAt: null,
    active: true,
    selectedAt: new Date('2026-06-10T00:00:00Z'),
    modelSpecId: null,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    ...over,
  };
}

describe('VehiclesService.getActiveVehicle · B5-3 enriquecimiento con seats/segment del modelSpec', () => {
  function make(
    vehicles: Vehicle[],
    spec: { seats: number; segment: string | null } | null,
    docs: { type: string; status: string }[] = [],
  ) {
    const prisma = {
      read: {
        vehicle: { findMany: vi.fn().mockResolvedValue(vehicles) },
        vehicleModelSpec: { findUnique: vi.fn().mockResolvedValue(spec) },
        fleetDocument: { findMany: vi.fn().mockResolvedValue(docs) },
      },
    };
    return { service: new VehiclesService(prisma as never, { getOrThrow: () => 2017 } as never), prisma };
  }

  it('CON modelSpecId: agrega seats/segment del spec al vehículo activo', async () => {
    const { service, prisma } = make([vehicleRow({ modelSpecId: 'spec-1' })], { seats: 7, segment: 'PREMIUM' });
    const active = await service.getActiveVehicle('driver-1');
    expect(active?.seats).toBe(7);
    expect(active?.segment).toBe('PREMIUM');
    expect(prisma.read.vehicleModelSpec.findUnique).toHaveBeenCalledWith({ where: { id: 'spec-1' } });
  });

  it('SIN modelSpecId (legacy): no consulta el catálogo, sin attrs (degradación)', async () => {
    const { service, prisma } = make([vehicleRow({ modelSpecId: null })], null);
    const active = await service.getActiveVehicle('driver-1');
    expect(active?.seats).toBeUndefined();
    expect(active?.segment).toBeUndefined();
    expect(prisma.read.vehicleModelSpec.findUnique).not.toHaveBeenCalled();
  });

  it('B5-3.2 · adjunta las certificaciones VIGENTES del conductor (para el gate de verticales en dispatch)', async () => {
    const { service, prisma } = make([vehicleRow({ modelSpecId: null })], null, [
      { type: 'AMBULANCE_OPERATOR', status: 'VALID' },
      { type: 'TOW_OPERATOR', status: 'EXPIRED' }, // vencida → fuera
      { type: 'LICENSE_A1', status: 'VALID' }, // doc base → fuera (solo certs de vertical)
    ]);
    const active = await service.getActiveVehicle('driver-1');
    expect(active?.certifications).toEqual(['AMBULANCE_OPERATOR']);
    expect(prisma.read.fleetDocument.findMany).toHaveBeenCalledWith({
      where: { ownerType: 'DRIVER', ownerId: 'driver-1' },
    });
  });

  it('B5-3.2 · conductor sin certs → certifications vacío (dispatch lo trata fail-closed para verticales)', async () => {
    const { service } = make([vehicleRow({ modelSpecId: null })], null, []);
    const active = await service.getActiveVehicle('driver-1');
    expect(active?.certifications).toEqual([]);
  });

  it('sin vehículo operable → null', async () => {
    const { service } = make([], null);
    expect(await service.getActiveVehicle('driver-1')).toBeNull();
  });
});
