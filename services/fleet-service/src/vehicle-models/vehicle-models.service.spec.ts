/**
 * VehicleModelsService (B5-2.a) — el catálogo curado de modelos.
 * Lo crítico a fijar: el read SIEMPRE filtra por status=APPROVED (PENDING/REJECTED no se ofrecen para
 * elegir), aplica los filtros opcionales (vehicleType, q→OR make/model), pagina por keyset id y proyecta
 * al view sin filtrar campos de revisión. getById degrada con NotFound.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConflictError, NotFoundError, ValidationError } from '@veo/utils';
import { VehicleSegment, EnergySource } from '@veo/shared-types';
import { VehicleModelStatus, VehicleType, type VehicleModelSpec } from '../generated/prisma';
import { VehicleModelsService } from './vehicle-models.service';

function row(over: Partial<VehicleModelSpec> = {}): VehicleModelSpec {
  return {
    id: 'id-1',
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

function makeService(rows: VehicleModelSpec[]) {
  const findMany = vi.fn().mockResolvedValue(rows);
  // findFirst respeta el where completo (id + status) — espeja el filtro APPROVED de getById.
  const findFirst = vi.fn().mockImplementation(({ where }: { where: { id: string; status?: string } }) =>
    Promise.resolve(
      rows.find((r) => r.id === where.id && (where.status === undefined || r.status === where.status)) ?? null,
    ),
  );
  const prisma = { read: { vehicleModelSpec: { findMany, findFirst } } };
  const service = new VehicleModelsService(prisma as never);
  return { service, findMany, findFirst };
}

describe('VehicleModelsService.listApproved', () => {
  it('SIEMPRE filtra por status=APPROVED', async () => {
    const { service, findMany } = makeService([row()]);
    await service.listApproved({});
    expect(findMany.mock.calls[0]![0].where.status).toBe(VehicleModelStatus.APPROVED);
  });

  it('aplica el filtro vehicleType cuando se pasa', async () => {
    const { service, findMany } = makeService([]);
    await service.listApproved({ vehicleType: VehicleType.MOTO });
    expect(findMany.mock.calls[0]![0].where.vehicleType).toBe(VehicleType.MOTO);
  });

  it('q genera un OR contains insensitive sobre make y model', async () => {
    const { service, findMany } = makeService([]);
    await service.listApproved({ q: ' yar ' });
    const where = findMany.mock.calls[0]![0].where;
    expect(where.OR).toEqual([
      { make: { contains: 'yar', mode: 'insensitive' } },
      { model: { contains: 'yar', mode: 'insensitive' } },
    ]);
  });

  it('keyset por id: cursor → where.id gt; ordena por id asc', async () => {
    const { service, findMany } = makeService([]);
    await service.listApproved({ cursor: 'id-9' });
    const args = findMany.mock.calls[0]![0];
    expect(args.where.id).toEqual({ gt: 'id-9' });
    expect(args.orderBy).toEqual({ id: 'asc' });
  });

  it('proyecta al view (sin status/requestedBy/verifiedBy) con segment/energySource tipados', async () => {
    const { service } = makeService([row({ id: 'a' })]);
    const page = await service.listApproved({});
    expect(page.items[0]).toEqual({
      id: 'a',
      make: 'Toyota',
      model: 'Yaris',
      yearFrom: 2017,
      yearTo: 2024,
      vehicleType: VehicleType.CAR,
      seats: 5,
      segment: 'ECONOMY',
      energySource: 'GASOLINE_95',
      efficiency: 17,
    });
  });

  it('nextCursor se setea cuando hay más de `limit` filas', async () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })];
    const { service } = makeService(rows);
    const page = await service.listApproved({ limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe('b');
  });
});

describe('VehicleModelsService.getById', () => {
  it('devuelve el view del modelo', async () => {
    const { service } = makeService([row({ id: 'x', make: 'Kia', model: 'Rio' })]);
    const view = await service.getById('x');
    expect(view.make).toBe('Kia');
    expect(view.model).toBe('Rio');
  });

  it('lanza NotFound cuando no existe (degradación honesta)', async () => {
    const { service } = makeService([]);
    await expect(service.getById('nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('NO expone modelos PENDING/REJECTED: getById de un no-aprobado → NotFound', async () => {
    const { service, findFirst } = makeService([
      row({ id: 'pend', status: VehicleModelStatus.PENDING_REVIEW }),
      row({ id: 'rej', status: VehicleModelStatus.REJECTED }),
    ]);
    await expect(service.getById('pend')).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.getById('rej')).rejects.toBeInstanceOf(NotFoundError);
    // el where SIEMPRE incluye status=APPROVED
    expect(findFirst.mock.calls[0]![0].where.status).toBe(VehicleModelStatus.APPROVED);
  });
});

/**
 * Mock con store en memoria para el flujo de solicitud/revisión (B5-2.c): findFirst (dedup
 * case-insensitive), create, updateMany (CAS por id+status) y findUnique (relectura post-CAS).
 */
function makeReviewService(rows: VehicleModelSpec[]) {
  const store = [...rows];
  const captured: { create?: Record<string, unknown>; update?: Record<string, unknown> } = {};

  const findFirst = vi.fn().mockImplementation(({ where }: { where: Record<string, any> }) => {
    const mk = where.make?.equals?.toLowerCase();
    const md = where.model?.equals?.toLowerCase();
    return Promise.resolve(
      store.find(
        (r) => r.make.toLowerCase() === mk && r.model.toLowerCase() === md && r.yearFrom === where.yearFrom,
      ) ?? null,
    );
  });
  const findUnique = vi.fn().mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(store.find((r) => r.id === where.id) ?? null),
  );
  const create = vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
    captured.create = data;
    const created = row(data as Partial<VehicleModelSpec>);
    store.push(created);
    return Promise.resolve(created);
  });
  // CAS: solo aplica si existe una fila con ese id Y el status del where (PENDING_REVIEW).
  const updateMany = vi.fn().mockImplementation(({ where, data }: { where: { id: string; status: string }; data: Record<string, unknown> }) => {
    captured.update = data;
    const idx = store.findIndex((r) => r.id === where.id && r.status === where.status);
    if (idx === -1) return Promise.resolve({ count: 0 });
    store[idx] = { ...store[idx], ...data } as VehicleModelSpec;
    return Promise.resolve({ count: 1 });
  });

  const prisma = {
    read: { vehicleModelSpec: { findFirst, findUnique } },
    write: { vehicleModelSpec: { create, updateMany } },
  };
  const service = new VehicleModelsService(prisma as never);
  return { service, captured, create, updateMany };
}

const reqInput = {
  make: 'Toyota',
  model: 'Probox',
  yearFrom: 2015,
  yearTo: 2024,
  vehicleType: VehicleType.CAR,
  seats: 5,
};

describe('VehicleModelsService.requestModel · B5-2.c', () => {
  it('crea PENDING_REVIEW con ficha técnica NULL y requestedBy (no inventa datos)', async () => {
    const { service, captured } = makeReviewService([]);
    const view = await service.requestModel('driver-1', reqInput);
    expect(captured.create!.status).toBe(VehicleModelStatus.PENDING_REVIEW);
    expect(captured.create!.requestedBy).toBe('driver-1');
    expect(captured.create!.segment).toBeNull();
    expect(captured.create!.energySource).toBeNull();
    expect(captured.create!.efficiency).toBeNull();
    expect(view.status).toBe(VehicleModelStatus.PENDING_REVIEW);
  });

  it('rechaza yearTo < yearFrom (ValidationError)', async () => {
    const { service } = makeReviewService([]);
    await expect(
      service.requestModel('driver-1', { ...reqInput, yearFrom: 2024, yearTo: 2015 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('dedup: si el modelo ya existe (mismo make/model/yearFrom) → Conflict, no crea', async () => {
    const { service, create } = makeReviewService([
      row({ make: 'Toyota', model: 'Probox', yearFrom: 2015, status: VehicleModelStatus.APPROVED }),
    ]);
    await expect(service.requestModel('driver-1', reqInput)).rejects.toBeInstanceOf(ConflictError);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('VehicleModelsService.approve/reject · B5-2.c state machine', () => {
  it('approve PENDING→APPROVED completa la ficha técnica + verifiedBy', async () => {
    const { service, captured } = makeReviewService([
      row({ id: 'p1', status: VehicleModelStatus.PENDING_REVIEW, segment: null, energySource: null, efficiency: null }),
    ]);
    const view = await service.approve('p1', 'admin-9', {
      segment: VehicleSegment.MID,
      energySource: EnergySource.DIESEL,
      efficiency: 12,
    });
    expect(captured.update!.status).toBe(VehicleModelStatus.APPROVED);
    expect(captured.update!.segment).toBe(VehicleSegment.MID);
    expect(captured.update!.energySource).toBe(EnergySource.DIESEL);
    expect(captured.update!.efficiency).toBe(12);
    expect(captured.update!.verifiedBy).toBe('admin-9');
    expect(view.status).toBe(VehicleModelStatus.APPROVED);
  });

  it('approve de algo YA aprobado → Conflict (CAS: updateMany count 0)', async () => {
    const { service } = makeReviewService([row({ id: 'a1', status: VehicleModelStatus.APPROVED })]);
    await expect(
      service.approve('a1', 'admin-9', {
        segment: VehicleSegment.MID,
        energySource: EnergySource.DIESEL,
        efficiency: 12,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('approve de un id inexistente → NotFound', async () => {
    const { service } = makeReviewService([]);
    await expect(
      service.approve('nope', 'admin-9', {
        segment: VehicleSegment.MID,
        energySource: EnergySource.DIESEL,
        efficiency: 12,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reject PENDING→REJECTED + verifiedBy', async () => {
    const { service, captured } = makeReviewService([
      row({ id: 'p2', status: VehicleModelStatus.PENDING_REVIEW }),
    ]);
    const view = await service.reject('p2', 'admin-9');
    expect(captured.update!.status).toBe(VehicleModelStatus.REJECTED);
    expect(captured.update!.verifiedBy).toBe('admin-9');
    expect(view.status).toBe(VehicleModelStatus.REJECTED);
  });

  it('reject de algo ya resuelto → Conflict', async () => {
    const { service } = makeReviewService([row({ id: 'r1', status: VehicleModelStatus.REJECTED })]);
    await expect(service.reject('r1', 'admin-9')).rejects.toBeInstanceOf(ConflictError);
  });
});
