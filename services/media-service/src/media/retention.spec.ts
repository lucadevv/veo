import { describe, it, expect } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { computeRetentionUntil, isExpired } from './retention';
import { RetentionSweeper } from './retention.sweeper';
import { StorageSandboxAdapter } from '../ports/storage/storage.module';
import type { StoragePort } from '../ports/storage/storage.port';
import type { Env } from '../config/env.schema';

/** Config de prueba: el prefijo de las copias derivadas (la clave se computa con `renderedKeyFor`). */
const config = new ConfigService<Env, true>({ WATERMARK_RENDERED_PREFIX: 'watermarked/' });

const startedAt = new Date('2026-05-01T00:00:00.000Z');
const base = { startedAt, defaultDays: 30, incidentDays: 180 };

describe('computeRetentionUntil · política de retención (BR-S03)', () => {
  it('por defecto retiene 30 días', () => {
    const until = computeRetentionUntil({ ...base, hasIncident: false, hasPanic: false });
    expect(until).toEqual(new Date('2026-05-31T00:00:00.000Z'));
  });

  it('con incidente retiene 180 días', () => {
    const until = computeRetentionUntil({ ...base, hasIncident: true, hasPanic: false });
    expect(until).toEqual(new Date('2026-10-28T00:00:00.000Z'));
  });

  it('con pánico la retención es indefinida (null)', () => {
    const until = computeRetentionUntil({ ...base, hasIncident: false, hasPanic: true });
    expect(until).toBeNull();
  });

  it('el pánico prevalece sobre el incidente (indefinido)', () => {
    const until = computeRetentionUntil({ ...base, hasIncident: true, hasPanic: true });
    expect(until).toBeNull();
  });
});

describe('isExpired', () => {
  const now = new Date('2026-06-15T00:00:00.000Z');
  it('expira si la fecha de retención ya pasó', () => {
    expect(isExpired(new Date('2026-06-01T00:00:00.000Z'), now)).toBe(true);
  });
  it('no expira si la retención es futura', () => {
    expect(isExpired(new Date('2026-07-01T00:00:00.000Z'), now)).toBe(false);
  });
  it('nunca expira con retención indefinida (null = pánico)', () => {
    expect(isExpired(null, now)).toBe(false);
  });
});

describe('RetentionSweeper.sweep · barrido de ciclo de vida (BR-S03)', () => {
  type Seg = { id: string; s3Key: string; retentionUntil: Date | null; tripId?: string };
  type Rendered = { id: string; segmentId?: string | null; tripId?: string };
  type FindManyArgs = {
    where: { retentionUntil: { lte: Date } };
    orderBy: { id: 'asc' };
    take: number;
    skip?: number;
    cursor?: { id: string };
  };

  /**
   * Fake de Prisma que respeta keyset paginado (orderBy id asc + take + skip/cursor) en `findMany`
   * y `deleteMany` por `id: { in: [...] }`. Captura cada llamada a findMany y cada batch borrado para
   * que los tests verifiquen paginación y batching reales (no N deletes por fila). `count` y la búsqueda
   * de solicitudes por `tripId` modelan el barrido TRIP-LEVEL (copias de requests con segmentId=null).
   */
  function makePrisma(segments: Seg[], rendered: Rendered[] = []) {
    const deleted: string[] = [];
    const findManyCalls: FindManyArgs[] = [];
    const deleteManyBatches: string[][] = [];
    const live = (): Seg[] => segments.filter((s) => !deleted.includes(s.id));

    const prisma = {
      read: {
        mediaSegment: {
          findMany: async (args: FindManyArgs): Promise<Pick<Seg, 'id' | 's3Key' | 'tripId'>[]> => {
            findManyCalls.push(args);
            const due = live()
              .filter(
                (s) =>
                  s.retentionUntil !== null &&
                  s.retentionUntil.getTime() <= args.where.retentionUntil.lte.getTime(),
              )
              .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
            const startIndex = args.cursor
              ? due.findIndex((s) => s.id === args.cursor!.id) + (args.skip ?? 0)
              : 0;
            return due
              .slice(startIndex, startIndex + args.take)
              .map((s) => ({ id: s.id, s3Key: s.s3Key, tripId: s.tripId }));
          },
          // Segmentos VIVOS (no borrados en este barrido) agrupados por viaje (Fase 3): UNA sola lectura para
          // todo el set (no `count` por tripId → sin N+1). Un viaje del set que NO aparece ⇒ DRENADO (0 vivos).
          groupBy: async ({
            where,
          }: {
            by: ['tripId'];
            where: { tripId: { in: string[] } };
            _count: { _all: true };
          }): Promise<{ tripId: string; _count: { _all: number } }[]> => {
            const counts = new Map<string, number>();
            for (const s of live()) {
              if (s.tripId != null && where.tripId.in.includes(s.tripId)) {
                counts.set(s.tripId, (counts.get(s.tripId) ?? 0) + 1);
              }
            }
            return [...counts.entries()].map(([tripId, n]) => ({ tripId, _count: { _all: n } }));
          },
        },
        videoAccessRequest: {
          // Lote 3: solicitudes por segmento (Fase 1.5) O por viajes completos (Fase 3, trip-level, `tripId IN`).
          // SIN filtrar por renderedS3Key: la clave de la copia se COMPUTA del id → cae también la huérfana.
          findMany: async ({
            where,
          }: {
            where: { segmentId?: { in: string[] }; tripId?: { in: string[] } };
          }): Promise<{ id: string }[]> =>
            rendered
              .filter((r) =>
                where.tripId !== undefined
                  ? r.tripId != null && where.tripId.in.includes(r.tripId)
                  : where.segmentId
                    ? r.segmentId != null && where.segmentId.in.includes(r.segmentId)
                    : false,
              )
              .map((r) => ({ id: r.id })),
        },
      },
      write: {
        mediaSegment: {
          deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
            deleteManyBatches.push([...where.id.in]);
            deleted.push(...where.id.in);
            return { count: where.id.in.length };
          },
        },
      },
    };
    return { prisma, deleted, findManyCalls, deleteManyBatches };
  }

  // Redis fake mínimo: sweep() no toca el lock (vive en run()); el cliente solo se inyecta.
  const fakeRedis = { set: async () => 'OK', del: async () => 1 };

  it('borra solo los segmentos vencidos y respeta los indefinidos y futuros', async () => {
    const now = new Date('2026-06-15T00:00:00.000Z');
    const segments: Seg[] = [
      {
        id: 'expired',
        s3Key: 'recordings/t1/expired.mp4',
        retentionUntil: new Date('2026-06-01T00:00:00.000Z'),
      },
      {
        id: 'future',
        s3Key: 'recordings/t2/future.mp4',
        retentionUntil: new Date('2026-07-01T00:00:00.000Z'),
      },
      { id: 'panic', s3Key: 'recordings/t3/panic.mp4', retentionUntil: null },
    ];
    const { prisma, deleted } = makePrisma(segments);
    const sweeper = new RetentionSweeper(
      prisma as never,
      new StorageSandboxAdapter(),
      fakeRedis as never,
      config,
    );

    const purged = await sweeper.sweep(now);

    expect(purged).toBe(1);
    expect(deleted).toEqual(['expired']);
  });

  it('pagina en lotes de PAGE_SIZE=500: 1200 vencidos → 3 páginas, purga 1200', async () => {
    const now = new Date('2026-06-15T00:00:00.000Z');
    const retentionUntil = new Date('2026-06-01T00:00:00.000Z');
    // ids zero-padded para que el orden lexicográfico (id asc del keyset) coincida con el numérico.
    const segments: Seg[] = Array.from({ length: 1200 }, (_, i) => ({
      id: `seg-${String(i).padStart(4, '0')}`,
      s3Key: `recordings/t/${i}.mp4`,
      retentionUntil,
    }));
    const { prisma, deleted, findManyCalls } = makePrisma(segments);
    const sweeper = new RetentionSweeper(
      prisma as never,
      new StorageSandboxAdapter(),
      fakeRedis as never,
      config,
    );

    const purged = await sweeper.sweep(now);

    expect(purged).toBe(1200);
    expect(deleted).toHaveLength(1200);
    // 3 findMany: páginas de 500 + 500 + 200 (<PAGE_SIZE → corta el loop sin una query vacía extra).
    expect(findManyCalls).toHaveLength(3);
    expect(findManyCalls[0]?.take).toBe(500);
    expect(findManyCalls[0]?.cursor).toBeUndefined();
    expect(findManyCalls[1]?.cursor).toEqual({ id: 'seg-0499' });
    expect(findManyCalls[1]?.skip).toBe(1);
    expect(findManyCalls[2]?.cursor).toEqual({ id: 'seg-0999' });
  });

  it('borra la DB en BATCH: un solo deleteMany por página, no N deletes por fila', async () => {
    const now = new Date('2026-06-15T00:00:00.000Z');
    const retentionUntil = new Date('2026-06-01T00:00:00.000Z');
    const segments: Seg[] = Array.from({ length: 1200 }, (_, i) => ({
      id: `seg-${String(i).padStart(4, '0')}`,
      s3Key: `recordings/t/${i}.mp4`,
      retentionUntil,
    }));
    const { prisma, deleteManyBatches } = makePrisma(segments);
    const sweeper = new RetentionSweeper(
      prisma as never,
      new StorageSandboxAdapter(),
      fakeRedis as never,
      config,
    );

    await sweeper.sweep(now);

    // Una sola escritura por página (3), no 1200 deletes por fila.
    expect(deleteManyBatches).toHaveLength(3);
    expect(deleteManyBatches.map((b) => b.length)).toEqual([500, 500, 200]);
  });

  it('FALLO PARCIAL en S3: el id que falla NO se borra de DB ni cuenta en purged; el resto sí', async () => {
    const now = new Date('2026-06-15T00:00:00.000Z');
    const retentionUntil = new Date('2026-06-01T00:00:00.000Z');
    const segments: Seg[] = [
      { id: 'ok-1', s3Key: 'recordings/t/ok-1.mp4', retentionUntil },
      { id: 'boom', s3Key: 'recordings/t/boom.mp4', retentionUntil },
      { id: 'ok-2', s3Key: 'recordings/t/ok-2.mp4', retentionUntil },
    ];
    const { prisma, deleted, deleteManyBatches } = makePrisma(segments);

    // Storage que lanza SOLO para la key conflictiva; el resto delega en el sandbox (borra OK).
    const sandbox = new StorageSandboxAdapter();
    const flakyStorage: StoragePort = {
      presignDownloadUrl: (input) => sandbox.presignDownloadUrl(input),
      presignUploadUrl: (input) => sandbox.presignUploadUrl(input),
      getObjectSize: () => sandbox.getObjectSize(),
      deletePrefix: (bucket, prefix) => sandbox.deletePrefix(bucket, prefix),
      getObjectStream: (key, bucket) => sandbox.getObjectStream(key, bucket),
      uploadObject: (input) => sandbox.uploadObject(input),
      deleteObject: async (key: string): Promise<void> => {
        if (key === 'recordings/t/boom.mp4') {
          throw new Error('S3 caído para este objeto');
        }
      },
    };
    const sweeper = new RetentionSweeper(prisma as never, flakyStorage, fakeRedis as never, config);

    const purged = await sweeper.sweep(now);

    // 'boom' falló en S3 → no entra a la fila a borrar; nunca se borra una fila cuyo objeto sigue vivo.
    expect(purged).toBe(2);
    expect(deleted.sort()).toEqual(['ok-1', 'ok-2']);
    expect(deleted).not.toContain('boom');
    // El batch de DB excluye el id fallido (deleteMany de los OK, no de los 3).
    expect(deleteManyBatches).toEqual([['ok-1', 'ok-2']]);
  });

  it('purga también las COPIAS con watermark quemado de los segmentos barridos (PII, Lote 3)', async () => {
    const now = new Date('2026-06-15T00:00:00.000Z');
    const retentionUntil = new Date('2026-06-01T00:00:00.000Z');
    const segments: Seg[] = [
      { id: 'seg-1', s3Key: 'recordings/t/seg-1.mp4', retentionUntil },
      { id: 'seg-2', s3Key: 'recordings/t/seg-2.mp4', retentionUntil },
    ];
    const rendered = [
      { segmentId: 'seg-1', id: 'req-1' },
      { segmentId: 'seg-2', id: 'req-2' },
    ];
    const { prisma } = makePrisma(segments, rendered);
    const sandbox = new StorageSandboxAdapter();
    const deletedKeys: string[] = [];
    const spyStorage: StoragePort = {
      presignDownloadUrl: (input) => sandbox.presignDownloadUrl(input),
      presignUploadUrl: (input) => sandbox.presignUploadUrl(input),
      getObjectSize: () => sandbox.getObjectSize(),
      deletePrefix: (bucket, prefix) => sandbox.deletePrefix(bucket, prefix),
      getObjectStream: (key, bucket) => sandbox.getObjectStream(key, bucket),
      uploadObject: (input) => sandbox.uploadObject(input),
      deleteObject: async (key: string): Promise<void> => {
        deletedKeys.push(key);
      },
    };
    const sweeper = new RetentionSweeper(prisma as never, spyStorage, fakeRedis as never, config);

    await sweeper.sweep(now);

    // Se borraron tanto los crudos como las copias con watermark quemado (PII no puede quedar).
    // La clave de la copia se COMPUTA del id de la solicitud (renderedKeyFor), no se lee de DB.
    expect(deletedKeys).toContain('recordings/t/seg-1.mp4');
    expect(deletedKeys).toContain('watermarked/req-1.mp4');
    expect(deletedKeys).toContain('watermarked/req-2.mp4');
  });

  it('borra la copia HUÉRFANA de un segmento barrido (renderedS3Key=null) por clave COMPUTADA (PII)', async () => {
    const now = new Date('2026-06-15T00:00:00.000Z');
    const retentionUntil = new Date('2026-06-01T00:00:00.000Z');
    const segments: Seg[] = [{ id: 'seg-1', s3Key: 'recordings/t/seg-1.mp4', retentionUntil }];
    // Solicitud cuyo render subió la copia pero la tx de READY falló → renderedS3Key quedó null en DB.
    // La copia con PII sigue en el storage bajo la clave determinista; DEBE borrarse igual (Ley 29733).
    const rendered = [{ segmentId: 'seg-1', id: 'req-orphan' }];
    const { prisma } = makePrisma(segments, rendered);
    const storage = new StorageSandboxAdapter();
    const orphanKey = 'watermarked/req-orphan.mp4';
    await storage.uploadObject({
      key: orphanKey,
      body: Buffer.from('copia-derivada-con-PII-huerfana'),
      contentType: 'video/mp4',
    });
    await expect(storage.getObjectStream(orphanKey)).resolves.toBeDefined();
    const sweeper = new RetentionSweeper(prisma as never, storage, fakeRedis as never, config);

    await sweeper.sweep(now);

    // La copia huérfana YA NO está: el sweeper la borró por clave computada, no por el campo DB (null).
    await expect(storage.getObjectStream(orphanKey)).rejects.toThrow();
  });

  it('purga la copia TRIP-LEVEL (segmentId=null) cuando el viaje queda SIN segmentos (gap de retención · Lote 3)', async () => {
    const now = new Date('2026-06-15T00:00:00.000Z');
    const retentionUntil = new Date('2026-06-01T00:00:00.000Z');
    const segments: Seg[] = [
      { id: 'seg-1', s3Key: 'recordings/t-drained/seg-1.mp4', retentionUntil, tripId: 't-drained' },
    ];
    // Solicitud TRIP-LEVEL: segmentId=null (acceso pedido por viaje completo). Su copia derivada NUNCA matchea
    // el filtro `segmentId IN (deletable)` de la Fase 1.5 → antes SOBREVIVÍA la retención indefinidamente.
    const rendered: Rendered[] = [{ id: 'req-trip', segmentId: null, tripId: 't-drained' }];
    const { prisma } = makePrisma(segments, rendered);
    const storage = new StorageSandboxAdapter();
    const tripLevelCopy = 'watermarked/req-trip.mp4';
    await storage.uploadObject({
      key: tripLevelCopy,
      body: Buffer.from('cabina-con-PII-trip-level'),
      contentType: 'video/mp4',
    });
    await expect(storage.getObjectStream(tripLevelCopy)).resolves.toBeDefined();
    const sweeper = new RetentionSweeper(prisma as never, storage, fakeRedis as never, config);

    await sweeper.sweep(now);

    // El viaje quedó DRENADO (0 segmentos vivos) → la copia trip-level con PII YA NO está (Fase 3).
    await expect(storage.getObjectStream(tripLevelCopy)).rejects.toThrow();
  });

  it('NO purga la copia trip-level si el viaje aún tiene segmentos vivos (operador re-ve el video al día siguiente)', async () => {
    const now = new Date('2026-06-15T00:00:00.000Z');
    const segments: Seg[] = [
      {
        id: 'seg-exp',
        s3Key: 'recordings/t-alive/seg-exp.mp4',
        retentionUntil: new Date('2026-06-01T00:00:00.000Z'),
        tripId: 't-alive',
      },
      {
        id: 'seg-fut',
        s3Key: 'recordings/t-alive/seg-fut.mp4',
        retentionUntil: new Date('2026-07-01T00:00:00.000Z'),
        tripId: 't-alive',
      },
    ];
    const rendered: Rendered[] = [{ id: 'req-trip', segmentId: null, tripId: 't-alive' }];
    const { prisma, deleted } = makePrisma(segments, rendered);
    const storage = new StorageSandboxAdapter();
    const tripLevelCopy = 'watermarked/req-trip.mp4';
    await storage.uploadObject({
      key: tripLevelCopy,
      body: Buffer.from('cabina-con-PII-aun-vigente'),
      contentType: 'video/mp4',
    });
    const sweeper = new RetentionSweeper(prisma as never, storage, fakeRedis as never, config);

    await sweeper.sweep(now);

    // seg-exp se barrió pero seg-fut sigue vivo → el viaje NO está drenado → la copia trip-level SOBREVIVE
    // (la fuente del render trip-level —"el último segmento del viaje"— todavía existe).
    expect(deleted).toEqual(['seg-exp']);
    await expect(storage.getObjectStream(tripLevelCopy)).resolves.toBeDefined();
  });
});
