/**
 * SEAM catálogo↔operabilidad (ADR 013) — CatalogOperabilityService.
 *
 * CLAVA la regla de negocio del delta (sin DB real: prisma mockeado, mismo estilo que expiry-*-suspension.spec):
 *   1) el admin DESACTIVA la última oferta de una CLASE (MOTO) → los conductores cuyo vehículo OPERADO es de esa
 *      clase reciben `fleet.driver_suspended` holdCause=CATEGORY_DISABLED, keyeado por userId; el estado se persiste;
 *   2) el admin RE-ACTIVA la clase → esos conductores reciben `fleet.driver_reactivated` holdCause=CATEGORY_DISABLED;
 *   3) un `catalog.updated` que NO cambia ninguna clase (un ajuste de precio) NO toca ningún hold (0 eventos), pero
 *      SÍ avanza el puntero de versión;
 *   4) un evento con version ≤ la aplicada (re-entrega / reordenado) se DESCARTA (idempotencia): 0 eventos, 0 escritura;
 *   5) solo el conductor cuyo vehículo OPERADO es de la clase apagada se ve afectado (no cualquiera que tenga un
 *      vehículo de esa clase pero opere otro).
 */
import { describe, it, expect, vi } from 'vitest';
import { CatalogOperabilityService, type CatalogOverlayPayload } from './catalog-operability.service';

interface MockVehicle {
  id: string;
  driverId: string | null;
  vehicleType: 'CAR' | 'MOTO';
  docStatus: 'VALID' | 'EXPIRING_SOON' | 'EXPIRED';
  selectedAt: Date | null;
  createdAt: Date;
}

interface StoredState {
  id: string;
  version: number;
  operableClasses: string[];
  updatedAt: Date;
}

interface OutboxRow {
  aggregateId: string;
  eventType: string;
  envelope: { eventType: string; payload: Record<string, unknown> };
}

/** Resuelve un `vehicle.findMany` del servicio: candidato (select {id,driverId}) o carga completa (por driverId in). */
function queryVehicles(all: MockVehicle[], args: Record<string, unknown>): unknown[] {
  const where = (args.where ?? {}) as Record<string, unknown>;
  const select = (args.select ?? {}) as Record<string, unknown>;
  if (select.vehicleType) {
    // Carga COMPLETA de los vehículos de los userIds candidatos (para pickActiveVehicle).
    const ids = (where.driverId as { in?: string[] })?.in ?? [];
    return all
      .filter((v) => v.driverId && ids.includes(v.driverId))
      .map((v) => ({
        driverId: v.driverId,
        vehicleType: v.vehicleType,
        docStatus: v.docStatus,
        selectedAt: v.selectedAt,
        createdAt: v.createdAt,
      }));
  }
  // Candidatos: vehículos de las clases objetivo con conductor (select {id, driverId}).
  const classes = (where.vehicleType as { in?: string[] })?.in ?? [];
  return all
    .filter((v) => v.driverId !== null && classes.includes(v.vehicleType))
    .map((v) => ({ id: v.id, driverId: v.driverId }));
}

function makeHarness(opts: { state: StoredState | null; vehicles: MockVehicle[] }) {
  const outbox: OutboxRow[] = [];
  const upserts: { version: number; operableClasses: string[] }[] = [];
  const tx = {
    outboxEvent: {
      create: vi.fn(async ({ data }: { data: OutboxRow }) => {
        outbox.push(data);
      }),
    },
  };
  const prisma = {
    read: {
      catalogOperableState: { findUnique: vi.fn(async () => opts.state) },
      vehicle: {
        findMany: vi.fn(async (args: Record<string, unknown>) => queryVehicles(opts.vehicles, args)),
      },
    },
    write: {
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
      catalogOperableState: {
        upsert: vi.fn(
          async ({ update }: { update: { version: number; operableClasses: string[] } }) => {
            upserts.push(update);
          },
        ),
      },
    },
  };
  const service = new CatalogOperabilityService(prisma as never);
  return { service, outbox, upserts, prisma };
}

/** Overlay que ENCIENDE VEO_MOTO (→ clase MOTO operable). */
function motoOn(version: number): CatalogOverlayPayload {
  return { version, overrides: [{ id: 'veo_moto', enabled: true }] };
}
/** Overlay que APAGA VEO_MOTO (→ MOTO vuelve a NO-operable; VEO_MECHANIC ya nace off). */
function motoOff(version: number): CatalogOverlayPayload {
  return { version, overrides: [{ id: 'veo_moto', enabled: false }] };
}

const NOW = new Date('2026-07-09T10:00:00.000Z');

const motoDriver: MockVehicle = {
  id: 'veh-moto',
  driverId: 'user-moto',
  vehicleType: 'MOTO',
  docStatus: 'VALID',
  selectedAt: new Date('2026-07-01T00:00:00.000Z'),
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
};
const carDriver: MockVehicle = {
  id: 'veh-car',
  driverId: 'user-car',
  vehicleType: 'CAR',
  docStatus: 'VALID',
  selectedAt: null,
  createdAt: new Date('2026-07-02T00:00:00.000Z'),
};

describe('CatalogOperabilityService · delta de clases operables', () => {
  it('APAGAR MOTO → suspende SOLO al conductor MOTO con fleet.driver_suspended holdCause=CATEGORY_DISABLED (por userId)', async () => {
    // Previo: MOTO estaba operable (el admin la había encendido); ahora la apaga.
    const h = makeHarness({
      state: {
        id: 'GLOBAL',
        version: 5,
        operableClasses: ['CAR', 'MOTO'],
        updatedAt: new Date(),
      },
      vehicles: [motoDriver, carDriver],
    });
    const result = await h.service.applyCatalogUpdate(motoOff(6), NOW);

    expect(result.skipped).toBe(false);
    expect(result.disabledClasses).toEqual(['MOTO']);
    expect(result.enabledClasses).toEqual([]);
    expect(result.suspended).toBe(1);

    // Un solo evento, para el conductor MOTO, por userId, con el discriminador de catálogo.
    expect(h.outbox).toHaveLength(1);
    const suspendRow = h.outbox[0]!;
    expect(suspendRow.eventType).toBe('fleet.driver_suspended');
    expect(suspendRow.envelope.payload).toMatchObject({
      userId: 'user-moto',
      holdCause: 'CATEGORY_DISABLED',
      suspendedAt: NOW.toISOString(),
    });
    // El conductor CAR NO se toca (opera una clase que sigue operable).
    expect(suspendRow.envelope.payload.userId).not.toBe('user-car');
    // Estado persistido con la nueva versión + set operable.
    expect(h.upserts).toEqual([{ version: 6, operableClasses: ['CAR'] }]);
  });

  it('RE-ACTIVAR MOTO → reincorpora al conductor MOTO con fleet.driver_reactivated holdCause=CATEGORY_DISABLED', async () => {
    const h = makeHarness({
      state: { id: 'GLOBAL', version: 6, operableClasses: ['CAR'], updatedAt: new Date() },
      vehicles: [motoDriver, carDriver],
    });
    const result = await h.service.applyCatalogUpdate(motoOn(7), NOW);

    expect(result.enabledClasses).toEqual(['MOTO']);
    expect(result.disabledClasses).toEqual([]);
    expect(result.reactivated).toBe(1);
    expect(h.outbox).toHaveLength(1);
    const reactivateRow = h.outbox[0]!;
    expect(reactivateRow.eventType).toBe('fleet.driver_reactivated');
    expect(reactivateRow.envelope.payload).toMatchObject({
      userId: 'user-moto',
      holdCause: 'CATEGORY_DISABLED',
    });
    expect(h.upserts).toEqual([{ version: 7, operableClasses: ['CAR', 'MOTO'] }]);
  });

  it('SIN cambio de clase (solo cambia un precio) → NO toca ningún hold, pero avanza la versión', async () => {
    const h = makeHarness({
      state: { id: 'GLOBAL', version: 7, operableClasses: ['CAR'], updatedAt: new Date() },
      vehicles: [motoDriver, carDriver],
    });
    // Overlay que solo ajusta el multiplicador de un servicio CAR (sigue enabled) → operable set intacto = [CAR].
    const result = await h.service.applyCatalogUpdate(
      { version: 8, overrides: [{ id: 'veo_economico', enabled: true }] },
      NOW,
    );

    expect(result.skipped).toBe(false);
    expect(result.disabledClasses).toEqual([]);
    expect(result.enabledClasses).toEqual([]);
    expect(h.outbox).toHaveLength(0); // NINGÚN hold tocado.
    expect(h.upserts).toEqual([{ version: 8, operableClasses: ['CAR'] }]); // pero la versión avanza.
  });

  it('IDEMPOTENTE: un evento con version ≤ la aplicada (re-entrega/reordenado) se descarta — 0 eventos, 0 escritura', async () => {
    const h = makeHarness({
      state: { id: 'GLOBAL', version: 8, operableClasses: ['CAR'], updatedAt: new Date() },
      vehicles: [motoDriver, carDriver],
    });
    // Re-entrega de un evento viejo (v6) que APAGABA MOTO: el guard monotónico lo ignora.
    const result = await h.service.applyCatalogUpdate(motoOff(6), NOW);
    expect(result.skipped).toBe(true);
    expect(h.outbox).toHaveLength(0);
    expect(h.upserts).toHaveLength(0);
  });

  it('solo el vehículo OPERADO decide: un conductor que TIENE una MOTO pero OPERA un CAR (selectedAt más nuevo) NO se suspende', async () => {
    const mixed: MockVehicle[] = [
      // Mismo conductor: una MOTO vieja + un CAR seleccionado más recientemente (el operado).
      { ...motoDriver, id: 'veh-moto-old', driverId: 'user-mix', selectedAt: new Date('2026-07-01') },
      {
        id: 'veh-car-new',
        driverId: 'user-mix',
        vehicleType: 'CAR',
        docStatus: 'VALID',
        selectedAt: new Date('2026-07-05'),
        createdAt: new Date('2026-07-05'),
      },
    ];
    const h = makeHarness({
      state: {
        id: 'GLOBAL',
        version: 5,
        operableClasses: ['CAR', 'MOTO'],
        updatedAt: new Date(),
      },
      vehicles: mixed,
    });
    const result = await h.service.applyCatalogUpdate(motoOff(6), NOW);
    // MOTO se apagó, pero su vehículo OPERADO es el CAR → no se suspende.
    expect(result.suspended).toBe(0);
    expect(h.outbox).toHaveLength(0);
    expect(h.upserts).toEqual([{ version: 6, operableClasses: ['CAR'] }]);
  });
});
