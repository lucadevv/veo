/**
 * InspectionsService.create — integridad del audit de compliance + idempotencia (ITV).
 *
 * FIX 1 (inspectorId server-truth): el `inspectorId` PERSISTIDO es SIEMPRE el actor autenticado (el que el
 * controller pasa desde `user.userId` del JWT), NUNCA un valor del body. El DTO ya no lo acepta; aunque un
 * caller forje el campo, el service lo ignora. Es la misma regla que el face-match: la identidad la pone el
 * server.
 *
 * FIX 2 (idempotencia): un re-POST (doble click / retry de red) NO duplica filas. El natural key
 * [vehicleId, inspectedAt, inspectorId] colapsa el duplicado EXACTO; ante P2002 el service devuelve la fila
 * ya escrita (respuesta idempotente), NUNCA un 500.
 */
import { describe, it, expect, vi } from 'vitest';
import { NotFoundError } from '@veo/utils';
import { Prisma, type Inspection, type Vehicle } from '../generated/prisma';
import { InspectionsService } from './inspections.service';

const VEHICLE_ID = '11111111-1111-7111-8111-111111111111';
const AUTHENTICATED_INSPECTOR = '22222222-2222-7222-8222-222222222222';
const FORGED_INSPECTOR = '33333333-3333-7333-8333-333333333333';
const INSPECTED_AT = '2026-06-20T10:00:00.000Z';

const INTERVAL_MONTHS = 3;

/** P2002 con la shape estructural que `isUniqueViolation` reconoce (name + code + meta.target). */
function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'x',
    meta: { target: ['vehicle_id', 'inspected_at', 'inspector_id'] },
  });
}

function inspectionRow(over: Partial<Inspection> = {}): Inspection {
  return {
    id: 'ins-existing',
    vehicleId: VEHICLE_ID,
    inspectorId: AUTHENTICATED_INSPECTOR,
    inspectedAt: new Date(INSPECTED_AT),
    passed: true,
    notes: null,
    nextDueAt: new Date('2026-09-20T10:00:00.000Z'),
    createdAt: new Date(INSPECTED_AT),
    ...over,
  } as Inspection;
}

/**
 * Doble de prisma. `createImpl` controla qué hace el write (capturar la data, o lanzar P2002). `existing`
 * es la fila que devuelve el `findUnique` de inspección (recuperación idempotente tras la colisión).
 */
function makeService(opts: {
  vehicle?: Vehicle | null;
  createImpl?: (args: { data: Record<string, unknown> }) => Promise<Inspection>;
  existing?: Inspection | null;
}) {
  const captured: { data?: Record<string, unknown> } = {};
  const create =
    opts.createImpl ??
    vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      captured.data = data;
      return Promise.resolve(inspectionRow(data as Partial<Inspection>));
    });
  // Si pasaron un createImpl propio (ej. lanza P2002) igual capturamos la data para aseverar el inspectorId.
  const wrappedCreate = vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
    captured.data = args.data;
    return create(args);
  });

  const findInspectionUnique = vi.fn().mockResolvedValue(opts.existing ?? null);

  const prisma = {
    read: {
      vehicle: {
        findUnique: vi.fn().mockResolvedValue(
          opts.vehicle === undefined ? ({ id: VEHICLE_ID } as Vehicle) : opts.vehicle,
        ),
      },
      inspection: { findUnique: findInspectionUnique },
    },
    write: { inspection: { create: wrappedCreate } },
  };
  const config = { getOrThrow: () => INTERVAL_MONTHS };
  const service = new InspectionsService(prisma as never, config as never);
  return { service, captured, wrappedCreate, findInspectionUnique };
}

describe('InspectionsService.create · FIX 1 (inspectorId = actor autenticado, no spoofeable)', () => {
  it('PERSISTE el inspectorId del actor autenticado (no un valor del body)', async () => {
    const { service, captured } = makeService({});
    await service.create({ vehicleId: VEHICLE_ID, passed: true }, AUTHENTICATED_INSPECTOR);
    expect(captured.data?.inspectorId).toBe(AUTHENTICATED_INSPECTOR);
  });

  it('IGNORA un inspectorId forjado en el body — gana SIEMPRE el del JWT', async () => {
    const { service, captured } = makeService({});
    // El DTO ya no declara inspectorId; un caller que igual lo cuele (cast) NO debe poder atribuir la ITV.
    await service.create(
      { vehicleId: VEHICLE_ID, passed: true, inspectorId: FORGED_INSPECTOR } as never,
      AUTHENTICATED_INSPECTOR,
    );
    expect(captured.data?.inspectorId).toBe(AUTHENTICATED_INSPECTOR);
    expect(captured.data?.inspectorId).not.toBe(FORGED_INSPECTOR);
  });

  it('rechaza con NotFoundError tipado si el vehículo no existe (no escribe)', async () => {
    const { service, wrappedCreate } = makeService({ vehicle: null });
    await expect(
      service.create({ vehicleId: VEHICLE_ID, passed: true }, AUTHENTICATED_INSPECTOR),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(wrappedCreate).not.toHaveBeenCalled();
  });
});

describe('InspectionsService.create · FIX 2 (idempotencia: un re-POST no duplica)', () => {
  it('ante P2002 (re-POST exacto) devuelve la fila YA escrita — respuesta idempotente, no un 500', async () => {
    const existing = inspectionRow({ id: 'ins-first' });
    const { service, findInspectionUnique } = makeService({
      createImpl: vi.fn().mockRejectedValue(uniqueViolation()),
      existing,
    });

    const result = await service.create(
      { vehicleId: VEHICLE_ID, passed: true, inspectedAt: INSPECTED_AT },
      AUTHENTICATED_INSPECTOR,
    );

    expect(result).toBe(existing);
    // Recupera por el natural key compuesto (mismo vehículo + instante + inspector autenticado).
    expect(findInspectionUnique).toHaveBeenCalledWith({
      where: {
        vehicleId_inspectedAt_inspectorId: {
          vehicleId: VEHICLE_ID,
          inspectedAt: new Date(INSPECTED_AT),
          inspectorId: AUTHENTICATED_INSPECTOR,
        },
      },
    });
  });

  it('propaga el error si P2002 pero la fila no aparece (caso degenerado: no se traga el error)', async () => {
    const { service } = makeService({
      createImpl: vi.fn().mockRejectedValue(uniqueViolation()),
      existing: null,
    });
    await expect(
      service.create(
        { vehicleId: VEHICLE_ID, passed: true, inspectedAt: INSPECTED_AT },
        AUTHENTICATED_INSPECTOR,
      ),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it('un error NO-P2002 se propaga tal cual (no se confunde con idempotencia)', async () => {
    const boom = new Error('DB caída');
    const { service, findInspectionUnique } = makeService({
      createImpl: vi.fn().mockRejectedValue(boom),
    });
    await expect(
      service.create({ vehicleId: VEHICLE_ID, passed: true }, AUTHENTICATED_INSPECTOR),
    ).rejects.toBe(boom);
    expect(findInspectionUnique).not.toHaveBeenCalled();
  });
});
