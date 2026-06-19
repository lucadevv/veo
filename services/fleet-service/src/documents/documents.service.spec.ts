/**
 * DocumentsService.create — anti-IDOR (HALLAZGO ALTA, FOUNDATION §14 defensa en profundidad).
 *
 * El servicio NO confía ciegamente en `ownerId` del body: valida PERTENENCIA contra el principal
 * autenticado de la identidad interna firmada.
 *  - DRIVER: `ownerId` (id de perfil Driver) DEBE coincidir con `identity.driverId` firmado por el BFF.
 *  - VEHICLE: el vehículo debe existir Y, si el caller es conductor, pertenecerle (`Vehicle.driverId
 *    === user.userId`, por el invariante de id de fleet).
 *  - Identidades admin/compliance (type !== 'driver') pasan: su authz la gobierna el RolesGuard.
 */
import { describe, it, expect, vi } from 'vitest';
import { ForbiddenError } from '@veo/utils';
import type { AuthenticatedUser } from '@veo/auth';
import { FleetDocumentType } from '@veo/shared-types';
import { FleetOwnerType, type FleetDocument } from '../generated/prisma';
import { DocumentsService } from './documents.service';

/** Identidad de conductor con driverId resuelto+firmado por el BFF (anti-IDOR). */
function driverIdentity(over: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    userId: 'user-1',
    type: 'driver',
    roles: [],
    sessionId: 'sess-1',
    driverId: 'driver-profile-1',
    ...over,
  };
}

/** Identidad de operador (admin/compliance): no es conductor, su authz va por RolesGuard. */
function adminIdentity(over: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    userId: 'admin-1',
    type: 'admin',
    roles: [],
    sessionId: 'sess-admin',
    ...over,
  };
}

/**
 * Identidad NO-admin NO-driver (confused deputy): un principal que NO es operador ni conductor.
 * Antes pasaba libre por el bug de allowlist-por-tipo; ahora cae fail-closed (denylist).
 */
function passengerIdentity(over: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    userId: 'user-passenger-1',
    type: 'passenger',
    roles: [],
    sessionId: 'sess-pax',
    ...over,
  };
}

/**
 * Doble de prisma: el vehículo opcional simula `Vehicle.driverId` (User.id del dueño); el create
 * captura la data y la devuelve como FleetDocument. `findFirst` (duplicado) siempre null.
 */
function makeService(
  opts: {
    vehicle?: { id: string; driverId: string | null } | null;
    /** filas que devuelve `findMany` (listExpirations). Default []. */
    expirationRows?: FleetDocument[];
  } = {},
) {
  const created: { data?: Record<string, unknown> } = {};
  const docCreate = vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
    created.data = data;
    return Promise.resolve({
      ...data,
      verifiedAt: null,
      verifiedBy: null,
      rejectionReason: null,
      createdAt: new Date('2026-06-19T00:00:00Z'),
      updatedAt: new Date('2026-06-19T00:00:00Z'),
    } as unknown as FleetDocument);
  });

  const vehicleFindUnique = vi.fn().mockResolvedValue(opts.vehicle ?? null);
  const docFindFirst = vi.fn().mockResolvedValue(null); // sin duplicado activo
  // findMany emula el keyset compuesto de Prisma: ordena el set por (expiresAt asc, id asc), aplica el
  // predicado OR del cursor (expiresAt > c.expiresAt OR (= AND id > c.id)) y recorta a `take`. Así el
  // test verifica el avance REAL del cursor (sin saltear ni duplicar), no solo el clamp del take.
  const sortRows = (rows: FleetDocument[]) =>
    [...rows].sort((a, b) => {
      const at = a.expiresAt ? a.expiresAt.getTime() : 0;
      const bt = b.expiresAt ? b.expiresAt.getTime() : 0;
      return at !== bt ? at - bt : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  const docFindMany = vi
    .fn()
    .mockImplementation(
      ({ take, where }: { take?: number; where?: Record<string, unknown> }) => {
        let rows = sortRows(opts.expirationRows ?? []);
        // El keyset llega anidado en where.AND[1].OR cuando hay cursor (ver listExpirations).
        const and = where?.AND as Array<Record<string, unknown>> | undefined;
        const orClause = and?.[1]?.OR as
          | Array<{ expiresAt?: { gt?: Date } | Date; id?: { gt?: string } }>
          | undefined;
        if (orClause) {
          const gt = orClause[0]?.expiresAt as { gt?: Date } | undefined;
          const eqAt = orClause[1]?.expiresAt as Date | undefined;
          const idGt = orClause[1]?.id as { gt?: string } | undefined;
          rows = rows.filter((r) => {
            const t = r.expiresAt ? r.expiresAt.getTime() : 0;
            const afterDate = gt?.gt ? t > gt.gt.getTime() : false;
            const sameDateAfterId =
              eqAt && idGt?.gt ? t === eqAt.getTime() && r.id > idGt.gt : false;
            return afterDate || sameDateAfterId;
          });
        }
        return Promise.resolve(typeof take === 'number' ? rows.slice(0, take) : rows);
      },
    );

  const prisma = {
    read: {
      vehicle: { findUnique: vehicleFindUnique },
      fleetDocument: { findFirst: docFindFirst, findMany: docFindMany },
    },
    write: { fleetDocument: { create: docCreate } },
  };
  const config = { getOrThrow: () => 30 };
  const service = new DocumentsService(prisma as never, config as never);
  return { service, created, docCreate, vehicleFindUnique, docFindMany };
}

const driverDoc = {
  ownerType: FleetOwnerType.DRIVER,
  type: FleetDocumentType.LICENSE_A1,
  documentNumber: 'A1-123',
};

const vehicleDoc = {
  ownerType: FleetOwnerType.VEHICLE,
  type: FleetDocumentType.SOAT,
  documentNumber: 'SOAT-999',
};

describe('DocumentsService.create · anti-IDOR DRIVER', () => {
  it('RECHAZA: conductor intenta crear un doc DRIVER de OTRO driverId', async () => {
    const { service, docCreate } = makeService();
    await expect(
      service.create(
        { ...driverDoc, ownerId: 'driver-profile-OTRO' },
        driverIdentity({ driverId: 'driver-profile-1' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(docCreate).not.toHaveBeenCalled();
  });

  it('RECHAZA: identidad de conductor SIN driverId firmado (BFF antiguo) → fail-closed', async () => {
    const { service, docCreate } = makeService();
    await expect(
      service.create({ ...driverDoc, ownerId: 'driver-profile-1' }, driverIdentity({ driverId: undefined })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(docCreate).not.toHaveBeenCalled();
  });

  it('OK: conductor crea un doc DRIVER de SU propio driverId (camino legítimo onboarding)', async () => {
    const { service, created } = makeService();
    const doc = await service.create(
      { ...driverDoc, ownerId: 'driver-profile-1' },
      driverIdentity({ driverId: 'driver-profile-1' }),
    );
    expect(doc.ownerId).toBe('driver-profile-1');
    expect(created.data?.ownerType).toBe(FleetOwnerType.DRIVER);
  });

  it('OK: admin crea un doc DRIVER de cualquier driverId (authz por RolesGuard, no IDOR driver↔driver)', async () => {
    const { service, created } = makeService();
    await service.create({ ...driverDoc, ownerId: 'driver-profile-cualquiera' }, adminIdentity());
    expect(created.data?.ownerId).toBe('driver-profile-cualquiera');
  });
});

describe('DocumentsService.create · anti-IDOR VEHICLE', () => {
  it('RECHAZA: conductor intenta crear un doc de un vehículo AJENO (existe, pero de otro dueño)', async () => {
    const { service, docCreate } = makeService({
      vehicle: { id: 'veh-1', driverId: 'user-OTRO' },
    });
    await expect(
      service.create({ ...vehicleDoc, ownerId: 'veh-1' }, driverIdentity({ userId: 'user-1' })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(docCreate).not.toHaveBeenCalled();
  });

  it('OK: conductor crea un doc de SU propio vehículo (Vehicle.driverId === user.userId)', async () => {
    const { service, created } = makeService({
      vehicle: { id: 'veh-1', driverId: 'user-1' },
    });
    await service.create({ ...vehicleDoc, ownerId: 'veh-1' }, driverIdentity({ userId: 'user-1' }));
    expect(created.data?.ownerId).toBe('veh-1');
    expect(created.data?.ownerType).toBe(FleetOwnerType.VEHICLE);
  });

  it('OK: admin crea un doc de cualquier vehículo (authz por RolesGuard)', async () => {
    const { service, created } = makeService({
      vehicle: { id: 'veh-1', driverId: 'user-OTRO' },
    });
    await service.create({ ...vehicleDoc, ownerId: 'veh-1' }, adminIdentity());
    expect(created.data?.ownerId).toBe('veh-1');
  });
});

describe('DocumentsService.create · confused deputy (denylist fail-closed)', () => {
  it('RECHAZA: identidad NO-admin NO-driver (passenger) crea un doc VEHICLE de owner AJENO', async () => {
    const { service, docCreate } = makeService({
      vehicle: { id: 'veh-1', driverId: 'user-OTRO' },
    });
    await expect(
      service.create({ ...vehicleDoc, ownerId: 'veh-1' }, passengerIdentity()),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(docCreate).not.toHaveBeenCalled();
  });

  it('RECHAZA: identidad NO-admin NO-driver (passenger) crea un doc DRIVER ajeno', async () => {
    const { service, docCreate } = makeService();
    await expect(
      service.create({ ...driverDoc, ownerId: 'driver-profile-cualquiera' }, passengerIdentity()),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(docCreate).not.toHaveBeenCalled();
  });
});

describe('DocumentsService.listExpirations · paginación cursor (reemplaza el cap silencioso)', () => {
  /**
   * Cola de 30 docs con expiresAt distintos crecientes (proximidad de vencimiento) + id uuidv7-like
   * ordenable. El doble de findMany emula el keyset compuesto, así que paginar de a 10 debe recorrer las
   * 30 filas EXACTAS, en orden, sin saltear ni duplicar.
   */
  const base = new Date('2026-07-01T00:00:00Z').getTime();
  const queue = Array.from(
    { length: 30 },
    (_, i) =>
      ({
        // id con padding para que el orden lexicográfico coincida con el orden de inserción (desempate).
        id: `doc-${String(i).padStart(3, '0')}`,
        expiresAt: new Date(base + i * 86_400_000),
      }) as unknown as FleetDocument,
  );

  it('take = limit + 1 con orderBy estable [{ expiresAt: asc }, { id: asc }] (keyset determinista)', async () => {
    const { service, docFindMany } = makeService({ expirationRows: queue });
    await service.listExpirations({ limit: 10 });
    const arg = docFindMany.mock.calls[0]?.[0] as { take?: number; orderBy?: unknown };
    expect(arg.take).toBe(11); // limit + 1 para detectar si hay siguiente página
    expect(arg.orderBy).toEqual([{ expiresAt: 'asc' }, { id: 'asc' }]);
  });

  /**
   * Cursor sólido incondicional (HALLAZGO ALTA + gemelo latente): el orden/keyset es por (expiresAt, id),
   * y una fila con expiresAt=null produciría un cursor `|<id>` que decodeExpiryCursor rechaza → loop.
   * Por eso el where DEBE filtrar `expiresAt: { not: null }` en AMBAS ramas (con y sin withinDays),
   * sin depender del invariante no-enforced de deriveExpiryStatus.
   */
  it('rama status-only (sin withinDays): el where filtra `expiresAt: { not: null }`', async () => {
    const { service, docFindMany } = makeService({ expirationRows: queue });
    await service.listExpirations({ limit: 10 });
    const where = docFindMany.mock.calls[0]?.[0]?.where as { expiresAt?: unknown };
    expect(where.expiresAt).toEqual({ not: null });
  });

  it('rama within-days (con withinDays): el where filtra `expiresAt: { not: null }`', async () => {
    const { service, docFindMany } = makeService({ expirationRows: queue });
    await service.listExpirations({ withinDays: 30, limit: 10 });
    const where = docFindMany.mock.calls[0]?.[0]?.where as { expiresAt?: { not?: unknown } };
    expect(where.expiresAt?.not).toBeNull();
  });

  it('default sin limit → take = 25 + 1 = 26 (DEFAULT_LIMIT)', async () => {
    const { service, docFindMany } = makeService({ expirationRows: queue });
    await service.listExpirations();
    const arg = docFindMany.mock.calls[0]?.[0] as { take?: number };
    expect(arg.take).toBe(26);
  });

  it('limit > MAX_LIMIT(100) se clampea a 100 (take = 101)', async () => {
    const { service, docFindMany } = makeService({ expirationRows: queue });
    await service.listExpirations({ limit: 500 });
    const arg = docFindMany.mock.calls[0]?.[0] as { take?: number };
    expect(arg.take).toBe(101);
  });

  it('primera página: devuelve `limit` items + nextCursor NO nulo cuando hay más', async () => {
    const { service } = makeService({ expirationRows: queue });
    const page = await service.listExpirations({ limit: 10 });
    expect(page.items).toHaveLength(10);
    expect(page.nextCursor).not.toBeNull();
    // El cursor codifica la tupla (expiresAt, id) de la última fila devuelta (doc-009).
    const last = page.items[9]!;
    expect(page.nextCursor).toBe(`${last.expiresAt!.toISOString()}|${last.id}`);
  });

  it('última página: nextCursor null (no hay fila extra)', async () => {
    const { service } = makeService({ expirationRows: queue.slice(0, 8) });
    const page = await service.listExpirations({ limit: 10 });
    expect(page.items).toHaveLength(8);
    expect(page.nextCursor).toBeNull();
  });

  it('el cursor avanza por TODA la cola sin saltear ni duplicar', async () => {
    const { service } = makeService({ expirationRows: queue });
    const seen: string[] = [];
    let cursor: string | undefined;
    // Recorre páginas de a 10 hasta agotar (máx 5 iteraciones, guarda anti-loop).
    for (let i = 0; i < 5; i++) {
      const page = await service.listExpirations({ limit: 10, cursor });
      seen.push(...page.items.map((d) => d.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const expected = queue.map((d) => d.id); // ya en orden (expiresAt asc, id asc)
    expect(seen).toEqual(expected); // 30 ids, en orden, sin duplicados ni gaps
    expect(new Set(seen).size).toBe(30);
  });
});
