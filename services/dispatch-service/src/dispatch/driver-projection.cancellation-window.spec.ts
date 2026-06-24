import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { DriverProjectionService } from './driver-projection.service';
import type { Env } from '../config/env.schema';

/**
 * VENTANA ROLLING de cancelaciones (auto-suspensión por exceso). Verifica:
 *  - 5 en 24h DISPARA `driver.excessive_cancellations` (cruce 4→5, una sola vez)
 *  - 5 repartidas en > 24h NO dispara (la poda saca las viejas → el conteo no llega al umbral)
 *  - poda de las > 24h
 *  - idempotencia por tripId (re-entrega del mismo trip no duplica ni re-cuenta)
 *  - emisión UNA sola vez (la 6ª, 7ª… cancelación no re-emite)
 *  - FIX 1 (poison-pill auto-infligido): la re-entrega del MISMO evento del CRUCE (4→5 re-entregado, donde el
 *    insert es no-op pero el count vuelve a dar threshold → re-entra la emisión y choca el @unique del outbox)
 *    es un NO-OP idempotente, NO crashea ni duplica el outbox.
 *  - FIX 2 (contador lifelong idempotente): `cancelledTrips` sube SOLO en insert nuevo; una re-entrega del
 *    mismo (driverId, tripId) NO infla la tasa.
 *
 * Prisma doble en memoria: modela `driver_cancellation_events` con el natural key (driverId, tripId) y el
 * @unique(dedupKey) del outbox — ambos lanzan un P2002 ESTRUCTURAL (name + code, como Prisma 5) al violarse,
 * que es exactamente lo que `isUniqueViolation` (@veo/database) detecta cross-cliente-generado.
 */
interface CancRow {
  driverId: string;
  tripId: string;
  occurredAt: Date;
}

/** P2002 ESTRUCTURAL (mismo shape que Prisma 5: `name` + `code` + `meta.target`) — lo que detecta isUniqueViolation. */
function p2002(target: string[]): Error {
  const err = new Error('Unique constraint failed') as Error & {
    code: string;
    meta: { target: string[] };
  };
  err.name = 'PrismaClientKnownRequestError';
  err.code = 'P2002';
  err.meta = { target };
  return err;
}

function makePrisma() {
  const rows: CancRow[] = [];
  const outbox: { eventType: string; dedupKey?: string; payload: unknown }[] = [];
  const stats = new Map<string, { driverId: string; cancelledTrips: number }>();
  const tx = {
    // Advisory lock por-conductor (paso 0 del fix de concurrencia cross-réplica): en el unit test mockeado es un
    // NO-OP semántico — no hay Postgres ni concurrencia real que serializar (la cobertura real de la carrera vive
    // en el e2e con testcontainers, cancellation-window.e2e.spec.ts caso (e)). Solo debe existir como función.
    $executeRaw: async () => 0,
    driverCancellationEvent: {
      // createMany + skipDuplicates = ON CONFLICT DO NOTHING: el conflicto del @unique([driverId,tripId]) NO
      // lanza ni aborta la tx; devuelve { count } = filas insertadas. count===1 → cancelación nueva; count===0 →
      // re-entrega del mismo natural key. (El mock NO puede reproducir el 25P02 que `create`+catch causaba en
      // Postgres real — esa evidencia nivel 1 vive en driver-projection.cancellation-window.int.spec.ts.)
      createMany: async (args: { data: CancRow[]; skipDuplicates?: boolean }) => {
        let inserted = 0;
        for (const data of args.data) {
          const dup = rows.find((r) => r.driverId === data.driverId && r.tripId === data.tripId);
          if (dup) {
            if (!args.skipDuplicates) throw p2002(['driverId', 'tripId']);
            continue; // ON CONFLICT DO NOTHING
          }
          rows.push({ ...data });
          inserted++;
        }
        return { count: inserted };
      },
      deleteMany: async (args: {
        where: { driverId: string; occurredAt: { lt: Date } };
      }) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          const r = rows[i]!;
          if (r.driverId === args.where.driverId && r.occurredAt < args.where.occurredAt.lt) {
            rows.splice(i, 1);
          }
        }
        return { count: before - rows.length };
      },
      count: async (args: { where: { driverId: string; occurredAt: { gte: Date } } }) =>
        rows.filter(
          (r) =>
            r.driverId === args.where.driverId && r.occurredAt >= args.where.occurredAt.gte,
        ).length,
    },
    driverStats: {
      findUnique: async (args: { where: { driverId: string } }) =>
        stats.get(args.where.driverId) ?? null,
      upsert: async (args: {
        where: { driverId: string };
        create: { driverId: string; cancelledTrips: number };
        // El fix usa el operador atómico de Prisma `{ increment: 1 }` (UPDATE cnt = cnt + 1 en Postgres) para
        // cerrar el lost-update. El mock interpreta ambas formas: número literal o `{ increment }`.
        update: { cancelledTrips: number | { increment: number } };
      }) => {
        const applyUpdate = (current: number): number => {
          const u = args.update.cancelledTrips;
          return typeof u === 'number' ? u : current + u.increment;
        };
        const existing = stats.get(args.where.driverId);
        if (existing) {
          existing.cancelledTrips = applyUpdate(existing.cancelledTrips);
          return existing;
        }
        const row = { ...args.create };
        stats.set(args.where.driverId, row);
        return row;
      },
    },
    outboxEvent: {
      // @unique(dedupKey): un segundo create con el MISMO dedupKey lanza P2002 (la garantía de idempotencia de
      // emisión). El servicio debe TRAGARLO como no-op, no relanzar (relanzar = crash-loop de partición).
      create: async (args: {
        data: { eventType: string; dedupKey?: string; envelope: { payload: unknown } };
      }) => {
        if (args.data.dedupKey && outbox.some((o) => o.dedupKey === args.data.dedupKey)) {
          throw p2002(['dedupKey']);
        }
        outbox.push({
          eventType: args.data.eventType,
          dedupKey: args.data.dedupKey,
          payload: args.data.envelope.payload,
        });
        return {};
      },
    },
  };
  return {
    rows,
    outbox,
    stats,
    write: { $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) },
  };
}

const config = new ConfigService<Env, true>({
  CANCELLATION_WINDOW_HOURS: 24,
  CANCELLATION_THRESHOLD: 5,
});

const DRIVER = '11111111-1111-1111-1111-111111111111';

function svc(prisma: ReturnType<typeof makePrisma>): DriverProjectionService {
  return new DriverProjectionService(prisma as never, config);
}

describe('DriverProjectionService · ventana rolling de cancelaciones', () => {
  let prisma: ReturnType<typeof makePrisma>;
  beforeEach(() => {
    prisma = makePrisma();
  });

  it('5 cancelaciones en 24h DISPARAN driver.excessive_cancellations UNA vez (cruce 4→5)', async () => {
    const s = svc(prisma);
    const base = new Date('2026-06-23T00:00:00.000Z').getTime();
    for (let i = 0; i < 5; i++) {
      await s.registerCancellationInWindow(
        DRIVER,
        `trip-${i}`,
        new Date(base + i * 60 * 60 * 1000), // 1h aparte → todas dentro de la ventana
      );
    }
    expect(prisma.outbox).toHaveLength(1);
    expect(prisma.outbox[0]!.eventType).toBe('driver.excessive_cancellations');
    const payload = prisma.outbox[0]!.payload as { driverId: string; count: number };
    expect(payload.driverId).toBe(DRIVER);
    expect(payload.count).toBe(5);
  });

  it('NO re-emite en la 6ª, 7ª cancelación (count > threshold, no es cruce)', async () => {
    const s = svc(prisma);
    const base = new Date('2026-06-23T00:00:00.000Z').getTime();
    for (let i = 0; i < 7; i++) {
      await s.registerCancellationInWindow(DRIVER, `trip-${i}`, new Date(base + i * 60 * 60 * 1000));
    }
    expect(prisma.outbox).toHaveLength(1); // solo el cruce 4→5
  });

  it('5 cancelaciones repartidas en > 24h NO disparan (la poda saca las viejas)', async () => {
    const s = svc(prisma);
    const base = new Date('2026-06-20T00:00:00.000Z').getTime();
    // Cada cancelación 8h después de la anterior: la 5ª está a 32h de la 1ª → al registrar la 5ª, la 1ª/2ª
    // ya cayeron fuera de la ventana de 24h (cutoff = 5ª - 24h) y se podan → el conteo no llega a 5.
    for (let i = 0; i < 5; i++) {
      await s.registerCancellationInWindow(DRIVER, `trip-${i}`, new Date(base + i * 8 * 60 * 60 * 1000));
    }
    expect(prisma.outbox).toHaveLength(0);
  });

  it('poda: las cancelaciones > 24h se borran de la tabla', async () => {
    const s = svc(prisma);
    const base = new Date('2026-06-20T00:00:00.000Z').getTime();
    await s.registerCancellationInWindow(DRIVER, 'old', new Date(base));
    // 30h después: la vieja queda fuera de la ventana → se poda al registrar la nueva.
    await s.registerCancellationInWindow(DRIVER, 'new', new Date(base + 30 * 60 * 60 * 1000));
    expect(prisma.rows.find((r) => r.tripId === 'old')).toBeUndefined();
    expect(prisma.rows.find((r) => r.tripId === 'new')).toBeDefined();
  });

  it('idempotencia por tripId: re-entrega del MISMO trip no duplica ni re-cuenta', async () => {
    const s = svc(prisma);
    const base = new Date('2026-06-23T00:00:00.000Z').getTime();
    // 4 cancelaciones distintas + la MISMA 4ª re-entregada (Kafka at-least-once): el count sigue en 4, no cruza.
    for (let i = 0; i < 4; i++) {
      await s.registerCancellationInWindow(DRIVER, `trip-${i}`, new Date(base + i * 60 * 60 * 1000));
    }
    await s.registerCancellationInWindow(DRIVER, 'trip-3', new Date(base + 3 * 60 * 60 * 1000)); // redelivery
    expect(prisma.rows).toHaveLength(4); // no duplicó
    expect(prisma.outbox).toHaveLength(0); // no cruzó el umbral por la re-entrega
  });

  it('MEZCLA pre+post: 5 cancelaciones de AMBAS fuentes (trip.cancelled + trip.reassigning) en 24h disparan UNA vez', async () => {
    const s = svc(prisma);
    const base = new Date('2026-06-23T00:00:00.000Z').getTime();
    // registerCancellationInWindow es AGNÓSTICO de la fuente: el handler de trip.cancelled by=DRIVER (pre-accept)
    // y el de trip.reassigning (post-accept) llaman al MISMO método. Acá modelamos 5 tripIds distintos como
    // llegarían MEZCLADOS de ambas ramas — el contador es uno solo, así que la mezcla cruza el umbral igual.
    const tripIds = [
      'pre-accept-A', // trip.cancelled by=DRIVER (cancelación pre-accept, desde ASSIGNED)
      'post-accept-B', // trip.reassigning (aceptó y abandonó — la abusiva)
      'pre-accept-C',
      'post-accept-D',
      'post-accept-E',
    ];
    for (let i = 0; i < tripIds.length; i++) {
      await s.registerCancellationInWindow(DRIVER, tripIds[i]!, new Date(base + i * 60 * 60 * 1000));
    }
    expect(prisma.outbox).toHaveLength(1);
    expect(prisma.outbox[0]!.eventType).toBe('driver.excessive_cancellations');
    expect((prisma.outbox[0]!.payload as { count: number }).count).toBe(5);
  });

  it('idempotencia cross-rama: el MISMO [driverId, tripId] visto pre Y post no se duplica (un solo evento de cancelación)', async () => {
    const s = svc(prisma);
    const base = new Date('2026-06-23T00:00:00.000Z').getTime();
    // Caso patológico: el mismo tripId del mismo conductor llega por las dos ramas (no debería pasar en la
    // máquina de estados, pero el natural key (driverId, tripId) lo cubre igual). Cuenta como UNA cancelación.
    await s.registerCancellationInWindow(DRIVER, 'trip-X', new Date(base));
    await s.registerCancellationInWindow(DRIVER, 'trip-X', new Date(base + 60 * 60 * 1000)); // misma (driver,trip)
    expect(prisma.rows).toHaveLength(1); // un solo evento, no se duplica
  });

  it('FIX 1 · re-entrega del EVENTO DEL CRUCE (4→5 re-entregado) es NO-OP idempotente: NO crashea ni duplica el outbox', async () => {
    const s = svc(prisma);
    const base = new Date('2026-06-23T00:00:00.000Z').getTime();
    // 5 cancelaciones distintas → cruce 4→5, emite UNA vez (dedupKey por el 5º trip).
    for (let i = 0; i < 5; i++) {
      await s.registerCancellationInWindow(DRIVER, `trip-${i}`, new Date(base + i * 60 * 60 * 1000));
    }
    expect(prisma.outbox).toHaveLength(1);
    // Kafka at-least-once RE-ENTREGA el MISMO 5º evento (el del cruce). FIX DE RAÍZ (createMany skipDuplicates +
    // early-return): el insert da count=0 (fila ya existe) → EARLY-RETURN inmediato → NO re-cuenta, NO re-emite,
    // NUNCA alcanza el outbox → el dedupKey jamás colisiona. Antes (create+catch DENTRO de la tx) el P2002 dejaba
    // la tx ABORTADA en Postgres (25P02) y el statement siguiente crasheaba → crash-loop de partición.
    await expect(
      s.registerCancellationInWindow(DRIVER, 'trip-4', new Date(base + 4 * 60 * 60 * 1000)),
    ).resolves.toBeUndefined();
    expect(prisma.outbox).toHaveLength(1); // sigue habiendo UN solo evento del cruce (no se duplicó)
    expect(prisma.rows).toHaveLength(5); // el insert re-entregado fue no-op (no duplicó la fila)
  });

  it('FIX 2 · contador LIFELONG (cancelledTrips) sube SOLO en insert nuevo: una re-entrega NO infla la tasa', async () => {
    const s = svc(prisma);
    const base = new Date('2026-06-23T00:00:00.000Z').getTime();
    // 3 cancelaciones distintas → cancelledTrips = 3.
    for (let i = 0; i < 3; i++) {
      await s.registerCancellationInWindow(DRIVER, `trip-${i}`, new Date(base + i * 60 * 60 * 1000));
    }
    expect(prisma.stats.get(DRIVER)?.cancelledTrips).toBe(3);
    // Re-entrega de trip-1 (mismo natural key): el insert choca P2002 → wasNew=false → NO re-incrementa el lifelong.
    await s.registerCancellationInWindow(DRIVER, 'trip-1', new Date(base + 1 * 60 * 60 * 1000));
    expect(prisma.stats.get(DRIVER)?.cancelledTrips).toBe(3); // idempotente: sigue en 3, no infló a 4
    expect(prisma.rows).toHaveLength(3); // tampoco duplicó la fila de la ventana
  });
});
