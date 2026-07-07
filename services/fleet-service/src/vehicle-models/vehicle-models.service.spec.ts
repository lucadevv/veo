/**
 * VehicleModelsService (B5-2.a) — el catálogo curado de modelos.
 * Lo crítico a fijar: el read SIEMPRE filtra por status=APPROVED (PENDING/REJECTED no se ofrecen para
 * elegir), aplica los filtros opcionales (vehicleType, q→OR make/model), pagina por keyset id y proyecta
 * al view sin filtrar campos de revisión. getById degrada con NotFound.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConflictError, NotFoundError, ValidationError } from '@veo/utils';
import { VehicleSegment, EnergySource } from '@veo/shared-types';
import {
  VehicleModelSource,
  VehicleModelStatus,
  VehicleType,
  type VehicleModelSpec,
} from '../generated/prisma';
import { VehicleModelsService } from './vehicle-models.service';
import { normalizeModelTerm } from './vehicle-model-normalize';

/** Config doble: solo expone el umbral del fuzzy-match (LOTE 3). */
const fakeConfig = { getOrThrow: () => 0.45 } as never;

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
    energySource: 'GASOLINE_90',
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

function makeService(rows: VehicleModelSpec[]) {
  const findMany = vi.fn().mockResolvedValue(rows);
  // findFirst respeta el where completo (id + status) — espeja el filtro APPROVED de getById.
  const findFirst = vi
    .fn()
    .mockImplementation(({ where }: { where: { id: string; status?: string } }) =>
      Promise.resolve(
        rows.find(
          (r) => r.id === where.id && (where.status === undefined || r.status === where.status),
        ) ?? null,
      ),
    );
  const prisma = { read: { vehicleModelSpec: { findMany, findFirst } } };
  const service = new VehicleModelsService(prisma as never, fakeConfig);
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
      energySource: 'GASOLINE_90',
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

/** Vehículo mínimo para el re-link: solo los campos que `relinkPendingVehicles` lee. */
type VehicleRow = {
  id: string;
  make: string;
  model: string;
  year: number;
  vehicleType: VehicleType;
  modelSpecId: string | null;
};
function vrow(over: Partial<VehicleRow> = {}): VehicleRow {
  return {
    id: 'veh-1',
    make: 'Toyota',
    model: 'Yaris',
    year: 2020,
    vehicleType: VehicleType.CAR,
    modelSpecId: null,
    ...over,
  };
}

/**
 * Mock con store en memoria para el flujo de solicitud/revisión (B5-2.c): findFirst (dedup
 * case-insensitive), create, updateMany (CAS por id+status) y findUnique (relectura post-CAS).
 * `vehicles`: store de vehículos para el HEAL del re-link al aprobar (tx.vehicle.findMany/updateMany).
 */
function makeReviewService(rows: VehicleModelSpec[], vehicles: VehicleRow[] = []) {
  const store = [...rows];
  const vehicleStore = vehicles.map((v) => ({ ...v }));
  const captured: { create?: Record<string, unknown>; update?: Record<string, unknown> } = {};

  const findFirst = vi.fn().mockImplementation(({ where }: { where: Record<string, any> }) => {
    const mk = where.make?.equals?.toLowerCase();
    const md = where.model?.equals?.toLowerCase();
    return Promise.resolve(
      store.find(
        (r) =>
          r.make.toLowerCase() === mk &&
          r.model.toLowerCase() === md &&
          r.yearFrom === where.yearFrom,
      ) ?? null,
    );
  });
  const findUnique = vi
    .fn()
    .mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(store.find((r) => r.id === where.id) ?? null),
    );
  const create = vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
    captured.create = data;
    const created = row(data);
    store.push(created);
    return Promise.resolve(created);
  });
  // CAS: solo aplica si existe una fila con ese id Y el status del where (PENDING_REVIEW).
  const updateMany = vi
    .fn()
    .mockImplementation(
      ({
        where,
        data,
      }: {
        where: { id: string; status: string };
        data: Record<string, unknown>;
      }) => {
        captured.update = data;
        const idx = store.findIndex((r) => r.id === where.id && r.status === where.status);
        if (idx === -1) return Promise.resolve({ count: 0 });
        store[idx] = { ...store[idx], ...data } as VehicleModelSpec;
        return Promise.resolve({ count: 1 });
      },
    );

  // findUniqueOrThrow: la relectura post-CAS dentro de la tx (transition() lee la fila ya transicionada
  // para proyectarla al view). Espeja findUnique pero LANZA si no existe (invariante: el CAS ya validó id).
  const findUniqueOrThrow = vi.fn().mockImplementation(({ where }: { where: { id: string } }) => {
    const found = store.find((r) => r.id === where.id);
    if (!found) return Promise.reject(new Error(`No VehicleModelSpec found for id ${where.id}`));
    return Promise.resolve(found);
  });
  // outboxEvent.create: el evento VEHICLE_MODEL_REVIEWED que transition() emite en la MISMA tx tras
  // aprobar/rechazar. El doble solo lo registra (no asertamos su contenido acá); devuelve la fila creada.
  const outboxCreate = vi
    .fn()
    .mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(data));

  // El service envuelve la transición en `this.prisma.write.$transaction(async (tx) => ...)`. El doble de
  // $transaction ejecuta el callback con el MISMO write mock como `tx` (patrón estándar: la tx comparte los
  // mismos dobles que el cliente fuera de la tx → un solo store en memoria, sin divergencia de estado).
  // `findUnique` dentro de la tx: el branch CAS-fail de transition() la usa para distinguir NotFound vs
  // Conflict (re-lee la fila tras un updateMany count 0).
  // tx.$executeRaw del re-link (HEAL al aprobar): UN UPDATE bounded-por-DB que linkea + snapshotea make/model
  // curados. El doble replica el predicado del UPDATE sobre el store: model_spec_id IS NULL (idempotente, no
  // pisa los ya linkeados) + vehicleType + año en [from,to] + canon normalizado (normalizeModelTerm espeja la
  // expr SQL). Los valores bindeados llegan en orden: [specId, specMake, specModel, vehicleType, yearFrom,
  // yearTo, specMakeNorm, specModelNorm]. Devuelve el count de filas afectadas (como Prisma.$executeRaw).
  const executeRaw = vi.fn().mockImplementation((_sql: TemplateStringsArray, ...v: unknown[]) => {
    const [specId, specMake, specModel, vehicleType, yearFrom, yearTo, makeNorm, modelNorm] = v as [
      string,
      string,
      string,
      VehicleType,
      number,
      number,
      string,
      string,
    ];
    let count = 0;
    vehicleStore.forEach((veh, i) => {
      if (
        veh.modelSpecId === null &&
        veh.vehicleType === vehicleType &&
        veh.year >= yearFrom &&
        veh.year <= yearTo &&
        normalizeModelTerm(veh.make) === makeNorm &&
        normalizeModelTerm(veh.model) === modelNorm
      ) {
        vehicleStore[i] = { ...veh, modelSpecId: specId, make: specMake, model: specModel };
        count++;
      }
    });
    return Promise.resolve(count);
  });

  const writeClient = {
    vehicleModelSpec: { create, updateMany, findUnique, findUniqueOrThrow },
    outboxEvent: { create: outboxCreate },
    $executeRaw: executeRaw,
  };
  const prisma = {
    read: { vehicleModelSpec: { findFirst, findUnique } },
    write: {
      ...writeClient,
      $transaction: (fn: (tx: typeof writeClient) => unknown) => Promise.resolve(fn(writeClient)),
    },
  };
  const service = new VehicleModelsService(prisma as never, fakeConfig);
  return { service, captured, create, updateMany, vehicleStore };
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

  it('LOTE 3 · source default DRIVER_REQUEST (el conductor lo eligió de "mi modelo no está")', async () => {
    const { service, captured } = makeReviewService([]);
    await service.requestModel('driver-1', reqInput);
    expect(captured.create!.source).toBe(VehicleModelSource.DRIVER_REQUEST);
  });

  it('LOTE 3 · source=OCR cuando lo encola el alta a texto libre (fuzzy sin match)', async () => {
    const { service, captured } = makeReviewService([]);
    await service.requestModel('driver-1', reqInput, VehicleModelSource.OCR);
    expect(captured.create!.source).toBe(VehicleModelSource.OCR);
    expect(captured.create!.status).toBe(VehicleModelStatus.PENDING_REVIEW);
  });
});

/**
 * LOTE 3 · FUZZY-MATCH (pg_trgm). El método ejecuta un $queryRaw que devuelve {id, score}; el doble captura
 * el TemplateStringsArray + los valores para asertar que (a) la query usa fleet.similarity sobre las columnas
 * normalizadas, y (b) los términos viajan como PARÁMETROS BINDEADOS (no concatenados en el SQL → no inyectable).
 */
function makeMatchService(opts: {
  queryRows: { id: string; score: number }[];
  spec?: VehicleModelSpec | null;
  threshold?: number;
}) {
  const captured: { sql?: TemplateStringsArray; values?: unknown[] } = {};
  const queryRaw = vi.fn().mockImplementation((sql: TemplateStringsArray, ...values: unknown[]) => {
    captured.sql = sql;
    captured.values = values;
    return Promise.resolve(opts.queryRows);
  });
  const findUnique = vi.fn().mockResolvedValue(opts.spec ?? null);
  const prisma = {
    read: { $queryRaw: queryRaw, vehicleModelSpec: { findUnique } },
  };
  const config = { getOrThrow: () => opts.threshold ?? 0.45 } as never;
  const service = new VehicleModelsService(prisma as never, config);
  return { service, captured, queryRaw, findUnique };
}

describe('VehicleModelsService.findBestApprovedMatch · LOTE 3 fuzzy-match', () => {
  it('match fuerte (score >= umbral) → devuelve {spec, score} (linkea el modelo curado)', async () => {
    const spec = row({ id: 'spec-yaris', make: 'Toyota', model: 'Yaris' });
    const { service } = makeMatchService({
      queryRows: [{ id: 'spec-yaris', score: 0.9 }],
      spec,
      threshold: 0.45,
    });
    const match = await service.findBestApprovedMatch('toyota', 'yaris', VehicleType.CAR);
    expect(match).not.toBeNull();
    expect(match!.spec.id).toBe('spec-yaris');
    expect(match!.score).toBe(0.9);
  });

  it('score por DEBAJO del umbral → null (sin link; el caller encolará)', async () => {
    const { service, findUnique } = makeMatchService({
      queryRows: [{ id: 'spec-x', score: 0.2 }],
      threshold: 0.45,
    });
    const match = await service.findBestApprovedMatch('Marca Rara', 'XYZ', VehicleType.CAR);
    expect(match).toBeNull();
    // no rehidrata el spec si no superó el umbral
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('sin candidatos (catálogo vacío para ese tipo) → null', async () => {
    const { service } = makeMatchService({ queryRows: [], threshold: 0.45 });
    expect(await service.findBestApprovedMatch('Toyota', 'Yaris', VehicleType.CAR)).toBeNull();
  });

  it('make/model que normalizan a vacío (solo espacios) → null sin tocar la DB', async () => {
    const { service, queryRaw } = makeMatchService({ queryRows: [], threshold: 0.45 });
    expect(await service.findBestApprovedMatch('   ', 'Yaris', VehicleType.CAR)).toBeNull();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('$queryRaw PARAMETRIZADO: términos normalizados van como VALORES bindeados, no en el SQL (no inyectable)', async () => {
    const spec = row({ id: 's1' });
    const { service, captured } = makeMatchService({
      queryRows: [{ id: 's1', score: 0.8 }],
      spec,
    });
    // Un intento de inyección clásico en el make: debe viajar como PARÁMETRO, nunca interpolado en el texto SQL.
    const evil = "x'; DROP TABLE fleet.vehicle_model_specs; --";
    await service.findBestApprovedMatch(evil, 'yaris', VehicleType.CAR);

    const sqlText = captured.sql!.join('?');
    // El SQL estático NO contiene el payload: el tagged-template lo separó en `values`.
    expect(sqlText).not.toContain('DROP TABLE');
    expect(sqlText).toContain('fleet.similarity');
    expect(sqlText).toContain('make_norm');
    expect(sqlText).toContain('model_norm');
    // El payload, ya NORMALIZADO (uppercase), está entre los valores bindeados (parametrizado).
    expect(captured.values).toContain(evil.trim().toUpperCase());
    expect(captured.values).toContain('YARIS');
    // El status y el vehicleType también viajan bindeados (no interpolados).
    expect(captured.values).toContain(VehicleModelStatus.APPROVED);
    expect(captured.values).toContain(VehicleType.CAR);
  });

  it('umbral configurable: con umbral 0.95 un score 0.9 ya NO matchea', async () => {
    const { service } = makeMatchService({
      queryRows: [{ id: 's1', score: 0.9 }],
      spec: row({ id: 's1' }),
      threshold: 0.95,
    });
    expect(await service.findBestApprovedMatch('toyota', 'yaris', VehicleType.CAR)).toBeNull();
  });
});

describe('VehicleModelsService.approve/reject · B5-2.c state machine', () => {
  it('approve PENDING→APPROVED completa la ficha técnica + verifiedBy', async () => {
    const { service, captured } = makeReviewService([
      row({
        id: 'p1',
        status: VehicleModelStatus.PENDING_REVIEW,
        segment: null,
        energySource: null,
        efficiency: null,
      }),
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

describe('VehicleModelsService.approve · HEAL re-link del eslabón vehículo↔config', () => {
  /** Spec PENDING del KTM (nacido del freetext OCR del vehículo), listo para aprobar. */
  function pendingKtm() {
    return row({
      id: 'spec-ktm',
      make: 'KTM',
      model: 'RC 200',
      yearFrom: 2021,
      yearTo: 2021,
      vehicleType: VehicleType.MOTO,
      status: VehicleModelStatus.PENDING_REVIEW,
      segment: null,
      energySource: null,
      efficiency: null,
    });
  }
  const approveDto = {
    segment: VehicleSegment.ECONOMY,
    energySource: EnergySource.GASOLINE_90,
    efficiency: 30,
    seats: 2,
  };

  it('al APROBAR linkea el vehículo que esperaba (freetext OCR, modelSpecId=null) → hereda la ficha + snapshotea make/model curados', async () => {
    // El vehículo se registró a texto libre en minúsculas/espaciado distinto: el canon normalizado debe igualar.
    const { service, vehicleStore } = makeReviewService(
      [pendingKtm()],
      [vrow({ id: 'v1', make: 'ktm', model: 'rc 200', year: 2021, vehicleType: VehicleType.MOTO })],
    );
    await service.approve('spec-ktm', 'admin-9', approveDto);
    const v1 = vehicleStore.find((v) => v.id === 'v1')!;
    expect(v1.modelSpecId).toBe('spec-ktm');
    // Snapshot server-authoritative: el casing crudo del OCR ('ktm'/'rc 200') se reemplaza por el canon curado.
    expect(v1.make).toBe('KTM');
    expect(v1.model).toBe('RC 200');
  });

  it('NO sobre-linkea: distinto modelo, tipo o año fuera de rango quedan intactos (modelSpecId=null)', async () => {
    const { service, vehicleStore } = makeReviewService(
      [pendingKtm()],
      [
        vrow({
          id: 'otroModelo',
          make: 'KTM',
          model: 'Duke 200',
          year: 2021,
          vehicleType: VehicleType.MOTO,
        }),
        vrow({
          id: 'otroTipo',
          make: 'KTM',
          model: 'RC 200',
          year: 2021,
          vehicleType: VehicleType.CAR,
        }),
        vrow({
          id: 'otroAnio',
          make: 'KTM',
          model: 'RC 200',
          year: 2019,
          vehicleType: VehicleType.MOTO,
        }),
      ],
    );
    await service.approve('spec-ktm', 'admin-9', approveDto);
    for (const id of ['otroModelo', 'otroTipo', 'otroAnio']) {
      expect(vehicleStore.find((v) => v.id === id)!.modelSpecId).toBeNull();
    }
  });

  it('RECHAZAR no linkea nada (el heal es solo de la aprobación)', async () => {
    const { service, vehicleStore } = makeReviewService(
      [pendingKtm()],
      [vrow({ id: 'v1', make: 'KTM', model: 'RC 200', year: 2021, vehicleType: VehicleType.MOTO })],
    );
    await service.reject('spec-ktm', 'admin-9');
    expect(vehicleStore.find((v) => v.id === 'v1')!.modelSpecId).toBeNull();
  });

  it('idempotente: un vehículo YA linkeado a otro modelo no se pisa', async () => {
    const { service, vehicleStore } = makeReviewService(
      [pendingKtm()],
      [
        vrow({
          id: 'yaLinkeado',
          make: 'KTM',
          model: 'RC 200',
          year: 2021,
          vehicleType: VehicleType.MOTO,
          modelSpecId: 'spec-viejo',
        }),
      ],
    );
    await service.approve('spec-ktm', 'admin-9', approveDto);
    expect(vehicleStore.find((v) => v.id === 'yaLinkeado')!.modelSpecId).toBe('spec-viejo');
  });
});

describe('VehicleModelsService.reopen · F2 corregir la ficha de un modelo aprobado', () => {
  it('APPROVED→PENDING_REVIEW: limpia verifiedBy y CONSERVA la ficha (sigue clasificando con el dato viejo)', async () => {
    const { service, captured } = makeReviewService([
      row({
        id: 'a1',
        status: VehicleModelStatus.APPROVED,
        segment: VehicleSegment.PREMIUM,
        energySource: EnergySource.DIESEL,
        efficiency: 12,
        verifiedBy: 'admin-1',
      }),
    ]);
    const view = await service.reopen('a1');
    expect(captured.update!.status).toBe(VehicleModelStatus.PENDING_REVIEW);
    expect(captured.update!.verifiedBy).toBeNull();
    // NO toca la ficha: el update solo cambia status+verifiedBy (no borra segment/energía/eficiencia de golpe).
    expect(captured.update).not.toHaveProperty('segment');
    expect(captured.update).not.toHaveProperty('energySource');
    expect(captured.update).not.toHaveProperty('efficiency');
    expect(view.status).toBe(VehicleModelStatus.PENDING_REVIEW);
  });

  it('reopen de algo NO aprobado (PENDING_REVIEW) → Conflict (CAS: solo reabre APPROVED)', async () => {
    const { service } = makeReviewService([
      row({ id: 'p1', status: VehicleModelStatus.PENDING_REVIEW }),
    ]);
    await expect(service.reopen('p1')).rejects.toBeInstanceOf(ConflictError);
  });

  it('reopen de un id inexistente → NotFound', async () => {
    const { service } = makeReviewService([]);
    await expect(service.reopen('nope')).rejects.toBeInstanceOf(NotFoundError);
  });
});
