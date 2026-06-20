/**
 * VehiclesService.registerForDriver — la resolución de marca/modelo del alta (B5-2.b).
 * Lo crítico: si el conductor eligió un modelo del CATÁLOGO (modelSpecId), make/model/vehicleType salen
 * del spec APPROVED (server-authoritative, ignora el texto libre); un spec inexistente/no-aprobado se
 * rechaza; sin modelSpecId cae al texto libre y exige make+model.
 */
import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { ConflictError, ValidationError } from '@veo/utils';
import { VehicleType as SharedVehicleType } from '@veo/shared-types';
import {
  VehicleDocStatus,
  VehicleModelSource,
  VehicleModelStatus,
  VehicleType,
  type Vehicle,
} from '../generated/prisma';
import { VehiclesService } from './vehicles.service';
import type { VehicleModelsService, VehicleModelMatch } from '../vehicle-models/vehicle-models.service';

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
    source: VehicleModelSource.SEED,
    requestedBy: null,
    verifiedBy: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

/**
 * LOTE 3 · doble de VehicleModelsService para el alta del conductor. Por defecto NO matchea nada
 * (findBestApprovedMatch → null) y captura las llamadas a requestModel (el encolado source=OCR).
 */
function makeVehicleModelsDouble(opts: { match?: VehicleModelMatch | null } = {}) {
  const findBestApprovedMatch = vi.fn().mockResolvedValue(opts.match ?? null);
  const requestModel = vi.fn().mockResolvedValue({});
  const double = { findBestApprovedMatch, requestModel } as unknown as VehicleModelsService;
  return { double, findBestApprovedMatch, requestModel };
}

/** Doble de prisma: captura la data del create y la devuelve como Vehicle completo. */
function makeService(opts: { spec?: ReturnType<typeof specRow> | null; match?: VehicleModelMatch | null } = {}) {
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
  const tx = {
    vehicle: { create: txCreate },
    outboxEvent: { create: vi.fn().mockResolvedValue({}) },
  };

  const findFirst = vi.fn().mockResolvedValue(opts.spec ?? null);
  const prisma = {
    read: {
      vehicle: {
        findUnique: vi.fn().mockResolvedValue(null), // no duplicado de placa
        findMany: vi
          .fn()
          .mockImplementation(() => Promise.resolve(created.data ? [created.data] : [])),
      },
      vehicleModelSpec: { findFirst },
    },
    write: { $transaction: (fn: (t: typeof tx) => unknown) => Promise.resolve(fn(tx)) },
  };
  const config = { getOrThrow: () => 2017 };
  const { double, findBestApprovedMatch, requestModel } = makeVehicleModelsDouble({ match: opts.match });
  const service = new VehiclesService(prisma as never, double, config as never);
  return { service, created, findFirst, txCreate, findBestApprovedMatch, requestModel };
}

// Ola 1 "solo autos": el cuerpo base usa CAR (clase operable). El rechazo de MOTO tiene su propio test.
const baseBody = { plate: 'ABC-123', year: 2022, vehicleType: SharedVehicleType.CAR };

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
    await service.registerForDriver('driver-1', { ...baseBody, make: 'Honda', model: 'Civic' });
    expect(created.data?.make).toBe('Honda');
    expect(created.data?.model).toBe('Civic');
    expect(created.data?.vehicleType).toBe(SharedVehicleType.CAR);
    expect(created.data?.modelSpecId).toBeNull();
  });

  it('LOTE 3 (a) · freetext que MATCHEA un aprobado → LINKEA ese modelSpecId, NO crea duplicado', async () => {
    // El fuzzy devuelve el spec "Toyota Yaris" para el freetext OCR "toyota yaris".
    const match = { spec: specRow({ id: 'spec-yaris' }), score: 1 };
    const { service, created, findBestApprovedMatch, requestModel } = makeService({ match });
    await service.registerForDriver('driver-1', { ...baseBody, make: 'toyota yaris', model: 'yaris' });

    // se consultó el fuzzy con el freetext + tipo
    expect(findBestApprovedMatch).toHaveBeenCalledWith('toyota yaris', 'yaris', SharedVehicleType.CAR);
    // linkea el modelSpecId del match y snapshotea make/model del spec curado (server-authoritative)
    expect(created.data?.modelSpecId).toBe('spec-yaris');
    expect(created.data?.make).toBe('Toyota');
    expect(created.data?.model).toBe('Yaris');
    // NO encola un duplicado: reusó el modelo curado
    expect(requestModel).not.toHaveBeenCalled();
  });

  it('LOTE 3 (b) · freetext SIN match → requestModel(source=OCR) + vehículo creado con el freetext', async () => {
    const { service, created, requestModel } = makeService({ match: null });
    await service.registerForDriver('driver-1', {
      ...baseBody,
      year: 2022,
      make: 'Marca Rara XYZ',
      model: 'Modelo Inexistente',
    });

    // encola el modelo nuevo: PENDING_REVIEW (dentro de requestModel) con source=OCR, requestedBy=driver
    expect(requestModel).toHaveBeenCalledTimes(1);
    const [requestedBy, dto, source] = requestModel.mock.calls[0]!;
    expect(requestedBy).toBe('driver-1');
    expect(source).toBe(VehicleModelSource.OCR);
    expect(dto).toMatchObject({
      make: 'Marca Rara XYZ',
      model: 'Modelo Inexistente',
      yearFrom: 2022,
      yearTo: 2022,
      vehicleType: SharedVehicleType.CAR,
    });
    // el vehículo se crea con el FREETEXT (modelSpecId null) — degradación honesta mientras el operador cura
    expect(created.data?.modelSpecId).toBeNull();
    expect(created.data?.make).toBe('Marca Rara XYZ');
    expect(created.data?.model).toBe('Modelo Inexistente');
  });

  it('LOTE 3 · si el encolado choca por dedup (ConflictError) NO rompe el alta del vehículo', async () => {
    const { double, findBestApprovedMatch, requestModel } = makeVehicleModelsDouble({ match: null });
    findBestApprovedMatch.mockResolvedValue(null);
    requestModel.mockRejectedValue(new ConflictError('ya solicitado', {}));

    // armamos un service con ese doble y un prisma mínimo (create + outbox + findMany)
    const created: { data?: Record<string, unknown> } = {};
    const tx = {
      vehicle: {
        create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          created.data = data;
          return Promise.resolve({
            ...data,
            id: 'veh-new',
            createdAt: new Date('2026-06-16T00:00:00Z'),
          } as unknown as Vehicle);
        }),
      },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      read: {
        vehicle: {
          findUnique: vi.fn().mockResolvedValue(null),
          findMany: vi.fn().mockResolvedValue([]),
        },
        vehicleModelSpec: { findFirst: vi.fn().mockResolvedValue(null) },
      },
      write: { $transaction: (fn: (t: typeof tx) => unknown) => Promise.resolve(fn(tx)) },
    };
    const service = new VehiclesService(prisma as never, double, { getOrThrow: () => 2017 } as never);

    // no debe lanzar: el ConflictError de dedup se traga, el vehículo se crea con freetext
    await expect(
      service.registerForDriver('driver-1', { ...baseBody, make: 'Repetida', model: 'Modelo' }),
    ).resolves.toBeDefined();
    expect(requestModel).toHaveBeenCalledTimes(1);
    expect(created.data?.modelSpecId).toBeNull();
  });

  it('LOTE 3 (c) · alta FALLIDA (placa de OTRO conductor, 409) NO ensucia la cola: NO se encola el modelo', async () => {
    // La placa YA existe y es de OTRO conductor → ConflictError de dominio ANTES de tocar el catálogo write.
    // El fuzzy (read) no matchea, pero como el alta falla, el modelo OCR NO debe encolarse (anti-DoS de la cola).
    const foreign = {
      id: 'veh-otro',
      plate: 'ABC-123',
      driverId: 'driver-OTRO',
      modelSpecId: null,
      active: false,
    } as unknown as Vehicle;
    const { double, findBestApprovedMatch, requestModel } = makeVehicleModelsDouble({ match: null });
    findBestApprovedMatch.mockResolvedValue(null);
    const prisma = {
      read: {
        vehicle: {
          findUnique: vi.fn().mockResolvedValue(foreign), // placa ocupada por otro
          findMany: vi.fn().mockResolvedValue([]),
        },
        vehicleModelSpec: { findFirst: vi.fn().mockResolvedValue(null) },
      },
      write: {
        $transaction: vi.fn(), // no debería invocarse
        vehicle: { update: vi.fn(), findUnique: vi.fn().mockResolvedValue(foreign) },
      },
    };
    const service = new VehiclesService(prisma as never, double, { getOrThrow: () => 2017 } as never);

    await expect(
      service.registerForDriver('driver-1', { ...baseBody, make: 'Marca Rara XYZ', model: 'Inexistente' }),
    ).rejects.toBeInstanceOf(ConflictError);

    // la cola NO se ensucia: el alta falló antes, el modelo OCR jamás se encoló
    expect(requestModel).not.toHaveBeenCalled();
  });

  it('LOTE 3 (d) · encolado post-éxito que FALLA (no-dedup) → vehículo IGUAL creado, error NO propagado', async () => {
    // El alta del vehículo tiene éxito; el encolado post-éxito explota con un error inesperado (NO dedup).
    // El vehículo debe quedar creado con freetext y el error NO debe propagarse (es best-effort, se loguea).
    const { double, findBestApprovedMatch, requestModel } = makeVehicleModelsDouble({ match: null });
    findBestApprovedMatch.mockResolvedValue(null);
    requestModel.mockRejectedValue(new Error('DB caída encolando el modelo'));

    const created: { data?: Record<string, unknown> } = {};
    const tx = {
      vehicle: {
        create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          created.data = data;
          return Promise.resolve({
            ...data,
            id: 'veh-ok',
            createdAt: new Date('2026-06-16T00:00:00Z'),
          } as unknown as Vehicle);
        }),
      },
      outboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      read: {
        vehicle: {
          findUnique: vi.fn().mockResolvedValue(null),
          findMany: vi.fn().mockResolvedValue([]),
        },
        vehicleModelSpec: { findFirst: vi.fn().mockResolvedValue(null) },
      },
      write: { $transaction: (fn: (t: typeof tx) => unknown) => Promise.resolve(fn(tx)) },
    };
    const service = new VehiclesService(prisma as never, double, { getOrThrow: () => 2017 } as never);
    // silencia el logger.error esperado (no contamina el output del test)
    const errSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    // NO debe lanzar: el alta tuvo éxito; el fallo del encolado es best-effort
    await expect(
      service.registerForDriver('driver-1', { ...baseBody, make: 'Marca Rara XYZ', model: 'Inexistente' }),
    ).resolves.toBeDefined();

    // el vehículo quedó creado con el freetext (modelSpecId null)
    expect(created.data?.modelSpecId).toBeNull();
    expect(created.data?.make).toBe('Marca Rara XYZ');
    // el encolado se intentó UNA vez y el fallo se logueó (no se tragó en silencio)
    expect(requestModel).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('texto libre con MOTO → ValidationError "solo autos" (Ola 1, mototaxi diferida)', async () => {
    const { service, txCreate } = makeService();
    await expect(
      service.registerForDriver('driver-1', {
        plate: 'ABC-123',
        year: 2022,
        vehicleType: SharedVehicleType.MOTO,
        make: 'Honda',
        model: 'CG 150',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(txCreate).not.toHaveBeenCalled();
  });

  it('SIN modelSpecId y SIN make/model → ValidationError', async () => {
    const { service } = makeService();
    await expect(service.registerForDriver('driver-1', { ...baseBody })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});

/**
 * Doble de prisma para el alta ADMIN (`create`): a diferencia del self-service, escribe con
 * `prisma.write.vehicle.create` directo (sin outbox/transacción). Captura la data del create.
 */
function makeCreateService(opts: { spec?: ReturnType<typeof specRow> | null } = {}) {
  const created: { data?: Record<string, unknown> } = {};
  const writeCreate = vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
    created.data = data;
    return Promise.resolve({
      ...data,
      docStatus: VehicleDocStatus.VALID,
      selectedAt: null,
      createdAt: new Date('2026-06-16T00:00:00Z'),
      updatedAt: new Date('2026-06-16T00:00:00Z'),
    } as unknown as Vehicle);
  });
  const findFirst = vi.fn().mockResolvedValue(opts.spec ?? null);
  const prisma = {
    read: {
      vehicle: { findUnique: vi.fn().mockResolvedValue(null) }, // sin duplicado de placa
      vehicleModelSpec: { findFirst },
    },
    write: { vehicle: { create: writeCreate } },
  };
  // Alta ADMIN: no pasa contexto fuzzy → el doble de VehicleModelsService no se ejerce (carga deliberada).
  const { double } = makeVehicleModelsDouble();
  const service = new VehiclesService(prisma as never, double, { getOrThrow: () => 2017 } as never);
  return { service, created, findFirst, writeCreate };
}

/**
 * Alta ADMIN por CATÁLOGO (F4 · C2): `create()` reusa la MISMA resolución que el self-service. El operador
 * elige un modelSpecId APPROVED → snapshot server-authoritative; el texto libre legacy sigue aceptado
 * (seeds/scripts); un spec MOTO se rechaza igual ("solo autos", Ola 1).
 */
describe('VehiclesService.create · F4 alta admin por catálogo', () => {
  const adminBase = { plate: 'XYZ-789', year: 2022, color: 'Negro' };

  it('CON modelSpecId APPROVED: snapshot make/model/vehicleType del spec (ignora texto libre) + guarda modelSpecId', async () => {
    const { service, created, findFirst } = makeCreateService({ spec: specRow() });
    await service.create({
      ...adminBase,
      modelSpecId: 'spec-1',
      make: 'BASURA',
      model: 'IGNORADA',
    } as never);
    expect(created.data?.make).toBe('Toyota');
    expect(created.data?.model).toBe('Yaris');
    expect(created.data?.vehicleType).toBe(VehicleType.CAR);
    expect(created.data?.modelSpecId).toBe('spec-1');
    expect(findFirst.mock.calls[0]![0].where.status).toBe(VehicleModelStatus.APPROVED);
  });

  it('modelSpecId inexistente/no-aprobado → ValidationError (no crea)', async () => {
    const { service, writeCreate } = makeCreateService({ spec: null });
    await expect(
      service.create({ ...adminBase, modelSpecId: 'spec-x' } as never),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(writeCreate).not.toHaveBeenCalled();
  });

  it('SIN modelSpecId: texto libre legacy, vehicleType default CAR, modelSpecId null', async () => {
    const { service, created } = makeCreateService();
    await service.create({ ...adminBase, make: 'Honda', model: 'Civic' } as never);
    expect(created.data?.make).toBe('Honda');
    expect(created.data?.model).toBe('Civic');
    expect(created.data?.vehicleType).toBe(VehicleType.CAR);
    expect(created.data?.modelSpecId).toBeNull();
  });

  it('modelSpecId de un spec MOTO → ValidationError "solo autos" (no crea)', async () => {
    const { service, writeCreate } = makeCreateService({
      spec: specRow({ vehicleType: VehicleType.MOTO }),
    });
    await expect(
      service.create({ ...adminBase, modelSpecId: 'spec-moto' } as never),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(writeCreate).not.toHaveBeenCalled();
  });
});

/**
 * Idempotencia ownership-aware del alta self-service (fix del 409 propio):
 *  - reenvío del MISMO conductor → no-op idempotente (UPDATE, sin 409, sin re-emitir el evento de alta);
 *  - misma placa de OTRO conductor → ConflictError de dominio ("otro conductor");
 *  - placa nueva → alta como siempre (create + outbox).
 */
function makeIdempotentService(existingPlate: Vehicle | null) {
  const txCreate = vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
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
  const outboxCreate = vi.fn().mockResolvedValue({});
  const tx = { vehicle: { create: txCreate }, outboxEvent: { create: outboxCreate } };

  const update = vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ ...(existingPlate as object), ...data } as unknown as Vehicle),
  );
  const findManyAfter = vi
    .fn()
    .mockResolvedValue(existingPlate ? [existingPlate] : []);

  const prisma = {
    read: {
      vehicle: {
        findUnique: vi.fn().mockResolvedValue(existingPlate),
        findMany: findManyAfter,
      },
      vehicleModelSpec: { findFirst: vi.fn().mockResolvedValue(null) },
    },
    write: {
      $transaction: (fn: (t: typeof tx) => unknown) => Promise.resolve(fn(tx)),
      vehicle: { update, findUnique: vi.fn().mockResolvedValue(existingPlate) },
    },
  };
  const { double } = makeVehicleModelsDouble();
  const service = new VehiclesService(prisma as never, double, { getOrThrow: () => 2017 } as never);
  return { service, txCreate, outboxCreate, update };
}

describe('VehiclesService.registerForDriver · idempotencia ownership-aware', () => {
  const body = {
    plate: 'ABC-123',
    year: 2022,
    vehicleType: VehicleType.CAR,
    make: 'Honda',
    model: 'Civic',
  };

  it('mismo conductor reenvía SU placa → idempotente: UPDATE, sin 409, sin re-emitir el evento de alta', async () => {
    const owned = {
      id: 'veh-1',
      plate: 'ABC-123',
      driverId: 'driver-1',
      modelSpecId: null,
      active: false,
    } as unknown as Vehicle;
    const { service, txCreate, outboxCreate, update } = makeIdempotentService(owned);

    const res = await service.registerForDriver('driver-1', { ...body, color: 'Rojo' });

    // no crea fila nueva ni re-emite el "registered"
    expect(txCreate).not.toHaveBeenCalled();
    expect(outboxCreate).not.toHaveBeenCalled();
    // actualiza el vehículo existente con lo reenviado
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0].where).toEqual({ id: 'veh-1' });
    expect(update.mock.calls[0]![0].data.color).toBe('Rojo');
    expect(res.id).toBe('veh-1');
  });

  it('otra placa del MISMO conductor distinta → ConflictError de otro conductor', async () => {
    const foreign = {
      id: 'veh-9',
      plate: 'ABC-123',
      driverId: 'driver-OTRO',
      modelSpecId: null,
      active: false,
    } as unknown as Vehicle;
    const { service, txCreate } = makeIdempotentService(foreign);

    await expect(
      service.registerForDriver('driver-1', body),
    ).rejects.toThrowError(/otro conductor/i);
    await expect(service.registerForDriver('driver-1', body)).rejects.toBeInstanceOf(ConflictError);
    expect(txCreate).not.toHaveBeenCalled();
  });

  it('placa nueva → alta normal: create + outbox', async () => {
    const { service, txCreate, outboxCreate, update } = makeIdempotentService(null);

    await service.registerForDriver('driver-1', body);

    expect(txCreate).toHaveBeenCalledTimes(1);
    expect(outboxCreate).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
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
    const { double } = makeVehicleModelsDouble();
    return {
      service: new VehiclesService(prisma as never, double, { getOrThrow: () => 2017 } as never),
      prisma,
    };
  }

  it('CON modelSpecId: agrega seats/segment del spec al vehículo activo', async () => {
    const { service, prisma } = make([vehicleRow({ modelSpecId: 'spec-1' })], {
      seats: 7,
      segment: 'PREMIUM',
    });
    const active = await service.getActiveVehicle('driver-1');
    expect(active?.seats).toBe(7);
    expect(active?.segment).toBe('PREMIUM');
    expect(prisma.read.vehicleModelSpec.findUnique).toHaveBeenCalledWith({
      where: { id: 'spec-1' },
    });
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
