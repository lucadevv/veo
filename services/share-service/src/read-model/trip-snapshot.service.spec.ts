/**
 * TripSnapshotService · DESENMASCARADO CONDICIONAL del read-model familiar (seguridad física).
 *
 * Propiedad de seguridad NO NEGOCIABLE (test adversarial): un `panic.resolved` con status RESOLVED
 * (emergencia REAL atendida) NUNCA desenmascara la vista familiar — la máscara PANIC se mantiene porque
 * el enlace pudo ser capturado por el agresor. SOLO FALSE_ALARM (falsa alarma) restaura el snapshot.
 *
 * También cubre `onPanic`: preserva el estado previo en prePanicStatus ANTES de pisar con PANIC, y es
 * idempotente ante redeliveries (no pisa el estado real guardado con "PANIC").
 */
import { describe, it, expect, vi } from 'vitest';
import { PanicStatus } from '@veo/shared-types';
import { TripSnapshotService } from './trip-snapshot.service';
import { PrismaTripSnapshotRepository } from './trip-snapshot.repository';
import type { PrismaService } from '../infra/prisma.service';

interface SnapshotRow {
  tripId: string;
  status: string;
  prePanicStatus: string | null;
  passengerId: string | null;
  lastLat: number | null;
  lastLon: number | null;
  lastLocationAt: Date | null;
}

/**
 * Prisma doble en memoria: una sola fila TripSnapshot por tripId. findUnique/upsert/update operan
 * contra un Map; $transaction ejecuta el callback con el mismo `tx`. Captura las escrituras para asertar.
 */
function buildPrisma(initial?: SnapshotRow) {
  const store = new Map<string, SnapshotRow>();
  if (initial) store.set(initial.tripId, initial);

  const tx = {
    tripSnapshot: {
      findUnique: vi.fn(
        async ({ where }: { where: { tripId: string } }) => store.get(where.tripId) ?? null,
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { tripId: string };
          create: Partial<SnapshotRow> & { tripId: string };
          update: Partial<SnapshotRow>;
        }) => {
          const existing = store.get(where.tripId);
          const next = existing
            ? { ...existing, ...update }
            : {
                prePanicStatus: null,
                passengerId: null,
                lastLat: null,
                lastLon: null,
                lastLocationAt: null,
                status: 'UNKNOWN',
                ...create,
              };
          store.set(where.tripId, next);
          return next;
        },
      ),
      update: vi.fn(
        async ({ where, data }: { where: { tripId: string }; data: Partial<SnapshotRow> }) => {
          const existing = store.get(where.tripId);
          if (!existing) throw new Error('row not found');
          const next = { ...existing, ...data };
          store.set(where.tripId, next);
          return next;
        },
      ),
    },
  };

  const prisma = {
    write: {
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
      ...tx,
    },
  } as unknown as PrismaService;

  return { prisma, tx, store };
}

const GEO = { lat: -12.04, lon: -77.04 };
const AT = new Date('2026-06-12T10:00:00Z');

describe('TripSnapshotService.onPanic · preserva el estado previo antes de enmascarar', () => {
  it('guarda el status actual (IN_PROGRESS) en prePanicStatus y pisa status con PANIC', async () => {
    const { prisma, store } = buildPrisma({
      tripId: 'trip-1',
      status: 'IN_PROGRESS',
      prePanicStatus: null,
      passengerId: 'pax-1',
      lastLat: null,
      lastLon: null,
      lastLocationAt: null,
    });
    const svc = new TripSnapshotService(new PrismaTripSnapshotRepository(prisma));

    await svc.onPanic('trip-1', 'pax-1', GEO, AT);

    const row = store.get('trip-1')!;
    expect(row.status).toBe('PANIC');
    expect(row.prePanicStatus).toBe('IN_PROGRESS');
  });

  it('idempotente: una redelivery (ya en PANIC) NO pisa prePanicStatus con "PANIC"', async () => {
    const { prisma, store } = buildPrisma({
      tripId: 'trip-1',
      status: 'PANIC',
      prePanicStatus: 'IN_PROGRESS',
      passengerId: 'pax-1',
      lastLat: null,
      lastLon: null,
      lastLocationAt: null,
    });
    const svc = new TripSnapshotService(new PrismaTripSnapshotRepository(prisma));

    await svc.onPanic('trip-1', 'pax-1', GEO, AT);

    const row = store.get('trip-1')!;
    expect(row.status).toBe('PANIC');
    expect(row.prePanicStatus).toBe('IN_PROGRESS'); // NO se corrompió a "PANIC"
  });

  it('pánico ANTES de trip.started (sin fila previa): prePanicStatus queda null, status=PANIC', async () => {
    const { prisma, store } = buildPrisma();
    const svc = new TripSnapshotService(new PrismaTripSnapshotRepository(prisma));

    await svc.onPanic('trip-1', 'pax-1', GEO, AT);

    const row = store.get('trip-1')!;
    expect(row.status).toBe('PANIC');
    expect(row.prePanicStatus).toBeNull();
  });
});

describe('TripSnapshotService.onPanicResolved · DESENMASCARADO CONDICIONAL (seguridad física)', () => {
  it('FALSE_ALARM → RESTAURA el snapshot fuera de PANIC (status=prePanicStatus) y limpia prePanicStatus', async () => {
    const { prisma, store } = buildPrisma({
      tripId: 'trip-1',
      status: 'PANIC',
      prePanicStatus: 'IN_PROGRESS',
      passengerId: 'pax-1',
      lastLat: GEO.lat,
      lastLon: GEO.lon,
      lastLocationAt: AT,
    });
    const svc = new TripSnapshotService(new PrismaTripSnapshotRepository(prisma));

    await svc.onPanicResolved('trip-1', PanicStatus.FALSE_ALARM);

    const row = store.get('trip-1')!;
    expect(row.status).toBe('IN_PROGRESS'); // máscara LEVANTADA
    expect(row.prePanicStatus).toBeNull();
  });

  it('ADVERSARIAL · RESOLVED → MANTIENE la máscara (status sigue PANIC). NO desenmascara JAMÁS', async () => {
    const { prisma, store, tx } = buildPrisma({
      tripId: 'trip-1',
      status: 'PANIC',
      prePanicStatus: 'IN_PROGRESS',
      passengerId: 'pax-1',
      lastLat: GEO.lat,
      lastLon: GEO.lon,
      lastLocationAt: AT,
    });
    const svc = new TripSnapshotService(new PrismaTripSnapshotRepository(prisma));

    await svc.onPanicResolved('trip-1', PanicStatus.RESOLVED);

    const row = store.get('trip-1')!;
    // PROPIEDAD DE SEGURIDAD: un RESOLVED NO restaura la ubicación en vivo para la familia.
    expect(row.status).toBe('PANIC');
    expect(row.prePanicStatus).toBe('IN_PROGRESS'); // intacto
    // NO-OP deliberado: ni siquiera abre transacción de escritura.
    expect(tx.tripSnapshot.update).not.toHaveBeenCalled();
  });

  it('ADVERSARIAL · ningún otro status (TRIGGERED/ACKNOWLEDGED) desenmascara — solo FALSE_ALARM', async () => {
    for (const status of [PanicStatus.TRIGGERED, PanicStatus.ACKNOWLEDGED] as const) {
      const { prisma, store } = buildPrisma({
        tripId: 'trip-1',
        status: 'PANIC',
        prePanicStatus: 'IN_PROGRESS',
        passengerId: 'pax-1',
        lastLat: null,
        lastLon: null,
        lastLocationAt: null,
      });
      const svc = new TripSnapshotService(new PrismaTripSnapshotRepository(prisma));
      await svc.onPanicResolved('trip-1', status);
      expect(store.get('trip-1')!.status, `status ${status} no debe desenmascarar`).toBe('PANIC');
    }
  });

  it('FALSE_ALARM sin prePanicStatus capturado (pánico pre-trip.started) → cae a UNKNOWN honesto', async () => {
    const { prisma, store } = buildPrisma({
      tripId: 'trip-1',
      status: 'PANIC',
      prePanicStatus: null,
      passengerId: 'pax-1',
      lastLat: null,
      lastLon: null,
      lastLocationAt: null,
    });
    const svc = new TripSnapshotService(new PrismaTripSnapshotRepository(prisma));

    await svc.onPanicResolved('trip-1', PanicStatus.FALSE_ALARM);

    const row = store.get('trip-1')!;
    expect(row.status).toBe('UNKNOWN');
    expect(row.prePanicStatus).toBeNull();
  });

  it('idempotente: snapshot NO en PANIC (ya desenmascarado) → FALSE_ALARM es no-op', async () => {
    const { prisma, store, tx } = buildPrisma({
      tripId: 'trip-1',
      status: 'IN_PROGRESS',
      prePanicStatus: null,
      passengerId: 'pax-1',
      lastLat: null,
      lastLon: null,
      lastLocationAt: null,
    });
    const svc = new TripSnapshotService(new PrismaTripSnapshotRepository(prisma));

    await svc.onPanicResolved('trip-1', PanicStatus.FALSE_ALARM);

    expect(store.get('trip-1')!.status).toBe('IN_PROGRESS');
    expect(tx.tripSnapshot.update).not.toHaveBeenCalled();
  });

  it('snapshot inexistente → FALSE_ALARM no rompe (no-op)', async () => {
    const { prisma, tx } = buildPrisma();
    const svc = new TripSnapshotService(new PrismaTripSnapshotRepository(prisma));
    await expect(svc.onPanicResolved('trip-x', PanicStatus.FALSE_ALARM)).resolves.toBeUndefined();
    expect(tx.tripSnapshot.update).not.toHaveBeenCalled();
  });
});
