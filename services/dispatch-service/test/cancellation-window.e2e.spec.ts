/**
 * E2E de la VENTANA ROLLING de cancelaciones (auto-suspensión por exceso) sobre Postgres REAL (testcontainers).
 *
 * POR QUÉ POSTGRES REAL Y NO EL MOCK: el bug que cierra este test es el poison-pill `25P02`
 * (`current transaction is aborted, commands ignored until end of transaction block`). El código viejo abría
 * una `$transaction` interactiva, hacía `create` del natural key (driverId, tripId), capturaba el P2002 con
 * try/catch DENTRO de la tx y SEGUÍA ejecutando `deleteMany`/`count`/`outbox` sobre la MISMA tx. En Postgres,
 * un error dentro de una tx interactiva la deja ABORTADA: el statement siguiente falla con `25P02`. Prisma 5
 * NO usa savepoints por-statement en `$transaction` interactivo, así que tragar el P2002 no des-aborta nada.
 * `25P02` NO está en PERMANENT_PRISMA_CODES → el handler lo trata como transitorio → `throw` → Kafka reintenta
 * el MISMO offset → crash-loop de partición. Un Prisma MOCKEADO NO reproduce esto (su "tx" en memoria no se
 * aborta tras un throw), por eso el bug se le escapó a la suite unitaria — solo Postgres real lo expone.
 *
 * El FIX DE RAÍZ usa `createMany({ skipDuplicates: true })` (= `INSERT ... ON CONFLICT DO NOTHING`, que NO
 * lanza ni aborta la tx) + EARLY-RETURN cuando count=0 (re-entrega) → nunca hay un unique-violation que tragar
 * dentro de la tx. Este test DEBE FALLAR con el código viejo (la re-entrega del cruce crashea con 25P02) y
 * PASAR con el fix (la re-entrega es no-op y la tx commitea limpia).
 *
 * Vive en test/ (excluido de tsc, igual que matching-session.e2e.spec.ts) porque usa testcontainers/import.meta.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import {
  createTestDatabase,
  runPrismaMigrateDeploy,
  type TestDatabase,
} from '@veo/database/testing';
import { PrismaClient } from '../src/generated/prisma';
import { DriverProjectionService } from '../src/dispatch/driver-projection.service';
import type { PrismaService } from '../src/infra/prisma.service';
import type { Env } from '../src/config/env.schema';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));
const DRIVER = '11111111-1111-1111-1111-111111111111';
const HOUR_MS = 60 * 60 * 1000;
const THRESHOLD = 5;
const WINDOW_HOURS = 24;
/** uuid determinista por índice (las columnas son @db.Uuid: un string arbitrario tiraría P2023). */
const tripUuid = (n: number): string =>
  `22222222-2222-2222-2222-${String(n).padStart(12, '0')}`;

let db: TestDatabase;
let prisma: PrismaClient;
let projection: DriverProjectionService;

beforeAll(async () => {
  db = await createTestDatabase({
    schema: 'dispatch',
    applyMigrations: (url: string) => runPrismaMigrateDeploy(url, serviceDir),
  });
  prisma = new PrismaClient({ datasourceUrl: db.databaseUrl });
  await prisma.$connect();
  const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
  const config = new ConfigService<Env, true>({
    CANCELLATION_WINDOW_HOURS: WINDOW_HOURS,
    CANCELLATION_THRESHOLD: THRESHOLD,
  } as Partial<Env> as Env);
  projection = new DriverProjectionService(prismaService, config);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.teardown();
});

beforeEach(async () => {
  // Aislamiento entre tests: limpiamos las tablas que tocamos (driver real, mismo a través de los its).
  await prisma.driverCancellationEvent.deleteMany({});
  await prisma.driverStats.deleteMany({});
  await prisma.outboxEvent.deleteMany({});
});

/** Emite las primeras `THRESHOLD` cancelaciones (1h aparte) → cruza el umbral exactamente en la 5ª. */
async function emitThresholdCrossing(base: number): Promise<void> {
  for (let i = 0; i < THRESHOLD; i++) {
    await projection.registerCancellationInWindow(DRIVER, tripUuid(i), new Date(base + i * HOUR_MS));
  }
}

describe('registerCancellationInWindow · Postgres real (cierre del 25P02)', () => {
  it('(a) la PRIMERA entrega del 5º evento cruza el umbral: inserta, count=5, emite UNA fila de outbox', async () => {
    const base = Date.parse('2026-06-23T00:00:00.000Z');
    await emitThresholdCrossing(base);

    const rows = await prisma.driverCancellationEvent.count({ where: { driverId: DRIVER } });
    expect(rows).toBe(THRESHOLD);

    const outbox = await prisma.outboxEvent.findMany({ where: { aggregateId: DRIVER } });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.eventType).toBe('driver.excessive_cancellations');
    const payload = outbox[0]!.envelope as unknown as { payload: { count: number } };
    expect(payload.payload.count).toBe(THRESHOLD);
  });

  it('(b) REDELIVERY del MISMO 5º evento: createMany skipDuplicates count=0 → early-return → NO re-cuenta, NO re-emite, NO crashea, tx COMMITEA limpia (sin 25P02)', async () => {
    const base = Date.parse('2026-06-23T00:00:00.000Z');
    await emitThresholdCrossing(base);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: DRIVER } })).toBe(1);

    // Kafka at-least-once RE-ENTREGA el MISMO 5º evento (el del cruce). Con el código viejo: el create choca el
    // @unique(driver_id, trip_id) → P2002 capturado DENTRO de la tx → la tx queda ABORTADA (25P02) → el
    // deleteMany/count siguiente lanza `current transaction is aborted` → este `await` RECHAZA → test ROJO.
    // Con el fix: createMany skipDuplicates da count=0 → early-return → resuelve sin tocar nada más.
    await expect(
      projection.registerCancellationInWindow(DRIVER, tripUuid(4), new Date(base + 4 * HOUR_MS)),
    ).resolves.toBeUndefined();

    // No re-contó (sigue 5 filas) ni re-emitió (sigue 1 fila de outbox).
    expect(await prisma.driverCancellationEvent.count({ where: { driverId: DRIVER } })).toBe(THRESHOLD);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: DRIVER } })).toBe(1);

    // PRUEBA DE QUE LA TX NO QUEDÓ ABORTADA: una operación NUEVA sobre el mismo cliente/pool funciona. Si la
    // redelivery hubiese dejado una tx colgada/abortada, este insert legítimo fallaría con 25P02.
    await expect(
      projection.registerCancellationInWindow(DRIVER, tripUuid(99), new Date(base + 5 * HOUR_MS)),
    ).resolves.toBeUndefined();
    expect(await prisma.driverCancellationEvent.count({ where: { driverId: DRIVER } })).toBe(THRESHOLD + 1);
  });

  it('(c) el contador LIFELONG (cancelledTrips) NO se infla en la redelivery', async () => {
    const base = Date.parse('2026-06-23T00:00:00.000Z');
    await emitThresholdCrossing(base);
    expect((await prisma.driverStats.findUnique({ where: { driverId: DRIVER } }))?.cancelledTrips).toBe(
      THRESHOLD,
    );

    // Redelivery del 3º evento (natural key ya existe) → early-return → lifelong NO sube.
    await projection.registerCancellationInWindow(DRIVER, tripUuid(2), new Date(base + 2 * HOUR_MS));
    expect((await prisma.driverStats.findUnique({ where: { driverId: DRIVER } }))?.cancelledTrips).toBe(
      THRESHOLD,
    );
  });

  it('(e) CONCURRENCIA del MISMO conductor: dos cancelaciones (trips distintos) en PARALELO emiten el cruce EXACTAMENTE una vez y el lifelong NO sufre lost-update', async () => {
    const base = Date.parse('2026-06-23T00:00:00.000Z');
    // Pre-commit THRESHOLD-2 cancelaciones (0..2 con THRESHOLD=5) → count en ventana = 3, aún por debajo del umbral.
    for (let i = 0; i < THRESHOLD - 2; i++) {
      await projection.registerCancellationInWindow(DRIVER, tripUuid(i), new Date(base + i * HOUR_MS));
    }
    expect(await prisma.driverCancellationEvent.count({ where: { driverId: DRIVER } })).toBe(THRESHOLD - 2);
    expect((await prisma.driverStats.findUnique({ where: { driverId: DRIVER } }))?.cancelledTrips).toBe(
      THRESHOLD - 2,
    );

    // Las DOS últimas (la (threshold-1)-ésima y la threshold-ésima), del MISMO conductor pero trips DISTINTOS
    // (en prod: keys/particiones/pods distintos → procesadas CONCURRENTEMENTE), lanzadas EN PARALELO.
    //
    // POR QUÉ DOS BARRERAS Y NO UN Promise.all "pelado": en prod la carrera es entre PODS distintos con latencia
    // de red por statement → las dos tx tienen sus ventanas SOLAPADAS de verdad. En un solo proceso Node, Prisma
    // intercala las $transaction (probado) pero el timing natural rara vez deja ambos READ del lifelong ANTES de
    // ambos WRITE → el lost-update casi no aflora (falso negativo). Las barreras fuerzan ese solape DETERMINISTA:
    //   B1 — tras el `createMany`: ambas tx ya insertaron su fila (trips distintos, sin conflicto) y quedan
    //        alineadas para la fase de lifelong.
    //   B2 — tras el `findUnique(driverStats)`: GARANTIZA que ambos READ del lifelong ocurran ANTES de cualquier
    //        WRITE → con el read-modify-write viejo ambas leen el MISMO valor y escriben leído+1 → una +1 se
    //        PIERDE → lifelong = THRESHOLD-1 → la aserción (b) FALLA. (Verificado contra Postgres real.)
    //   CON EL FIX: (1) el `increment: 1` atómico NO hace `findUnique` de driverStats → B2 NUNCA dispara → no hay
    //   ventana de lost-update; el UPDATE cnt=cnt+1 se serializa por lock de fila. (2) Además el advisory lock
    //   (paso 0) está ANTES del createMany → la 2ª tx se BLOQUEA y ni siquiera llega a B1; la 1ª expira el timeout
    //   de B1, commitea y libera el lock, la 2ª corre en serie. Resultado: 1 emisión + lifelong = THRESHOLD. PASA.
    const BARRIER_TIMEOUT_MS = 1_200;
    const makeBarrier = () => {
      let arrived = 0;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      return async () => {
        arrived += 1;
        if (arrived >= 2) release();
        await Promise.race([ready, new Promise((r) => setTimeout(r, BARRIER_TIMEOUT_MS))]);
      };
    };
    const afterInsert = makeBarrier();
    const afterStatsRead = makeBarrier();
    const instrumentedWrite = prisma.$extends({
      query: {
        driverCancellationEvent: {
          async createMany({ args, query }) {
            const result = await query(args);
            await afterInsert();
            return result;
          },
        },
        driverStats: {
          async findUnique({ args, query }) {
            // Solo el read-modify-write VIEJO llama a este findUnique; el increment atómico NO → con el fix esta
            // barrera nunca se dispara (su contador queda en 0, nadie la espera).
            const result = await query(args);
            await afterStatsRead();
            return result;
          },
        },
      },
    });
    const racingProjection = new DriverProjectionService(
      { read: prisma, write: instrumentedWrite } as unknown as PrismaService,
      new ConfigService<Env, true>({
        CANCELLATION_WINDOW_HOURS: WINDOW_HOURS,
        CANCELLATION_THRESHOLD: THRESHOLD,
      } as Partial<Env> as Env),
    );

    await Promise.all([
      racingProjection.registerCancellationInWindow(
        DRIVER,
        tripUuid(THRESHOLD - 2),
        new Date(base + (THRESHOLD - 2) * HOUR_MS),
      ),
      racingProjection.registerCancellationInWindow(
        DRIVER,
        tripUuid(THRESHOLD - 1),
        new Date(base + (THRESHOLD - 1) * HOUR_MS),
      ),
    ]);

    // (a) EXACTAMENTE UNA fila de outbox del cruce (no se perdió, no se duplicó).
    const outbox = await prisma.outboxEvent.findMany({
      where: { aggregateId: DRIVER, eventType: 'driver.excessive_cancellations' },
    });
    expect(outbox).toHaveLength(1);
    const payload = outbox[0]!.envelope as unknown as { payload: { count: number } };
    expect(payload.payload.count).toBe(THRESHOLD);
    // (b) lifelong correcto = THRESHOLD (sin lost-update: las dos +1 concurrentes ambas contaron). ESTA aserción
    //     es la que FALLA con el read-modify-write viejo (quedaría en THRESHOLD-1) y PASA con el increment atómico.
    expect((await prisma.driverStats.findUnique({ where: { driverId: DRIVER } }))?.cancelledTrips).toBe(
      THRESHOLD,
    );
    // (c) ambas filas de cancelación persisten.
    expect(await prisma.driverCancellationEvent.count({ where: { driverId: DRIVER } })).toBe(THRESHOLD);
  });

  it('(f) drivers DISTINTOS no se bloquean entre sí: dos conductores cruzan su umbral en paralelo, cada uno emite su propia fila', async () => {
    const base = Date.parse('2026-06-23T00:00:00.000Z');
    const DRIVER_B = '33333333-3333-3333-3333-333333333333';
    const tripFor = (driver: string, n: number): string =>
      driver === DRIVER ? tripUuid(n) : `44444444-4444-4444-4444-${String(n).padStart(12, '0')}`;

    // Cruzar el umbral de AMBOS conductores intercalando sus cancelaciones en paralelo. Como el lock es POR
    // driverId (clave distinta), no se serializan entre sí; cada uno alcanza su propio cruce === THRESHOLD.
    const crossDriver = async (driver: string): Promise<void> => {
      for (let i = 0; i < THRESHOLD; i++) {
        await projection.registerCancellationInWindow(
          driver,
          tripFor(driver, i),
          new Date(base + i * HOUR_MS),
        );
      }
    };
    await Promise.all([crossDriver(DRIVER), crossDriver(DRIVER_B)]);

    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: DRIVER, eventType: 'driver.excessive_cancellations' },
      }),
    ).toBe(1);
    expect(
      await prisma.outboxEvent.count({
        where: { aggregateId: DRIVER_B, eventType: 'driver.excessive_cancellations' },
      }),
    ).toBe(1);
    // Limpieza del driver B extra (beforeEach solo limpia por tabla, no por driver — pero deleteMany({}) sí; ok).
  });

  it('(d) poda >24h: una cancelación fuera de la ventana se borra al registrar la nueva y NO cuenta para el umbral', async () => {
    const base = Date.parse('2026-06-20T00:00:00.000Z');
    // 1 vieja + (>24h después) 4 nuevas dentro de ventana. La vieja se poda al registrar las nuevas → solo 4 en
    // la ventana → NO cruza el umbral (5).
    await projection.registerCancellationInWindow(DRIVER, tripUuid(0), new Date(base));
    for (let i = 1; i <= 4; i++) {
      await projection.registerCancellationInWindow(
        DRIVER,
        tripUuid(i),
        new Date(base + (WINDOW_HOURS + 6) * HOUR_MS + i * HOUR_MS),
      );
    }
    // La vieja fue podada (occurred_at < cutoff de la última).
    const remaining = await prisma.driverCancellationEvent.findMany({ where: { driverId: DRIVER } });
    expect(remaining.find((r) => r.tripId === tripUuid(0))).toBeUndefined();
    expect(remaining).toHaveLength(4);
    // 4 en ventana < umbral 5 → NO emite.
    expect(await prisma.outboxEvent.count({ where: { aggregateId: DRIVER } })).toBe(0);
  });
});
