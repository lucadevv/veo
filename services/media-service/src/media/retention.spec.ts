import { describe, it, expect } from 'vitest';
import { computeRetentionUntil, isExpired } from './retention';
import { RetentionSweeper } from './retention.sweeper';
import { StorageSandboxAdapter } from '../ports/storage/storage.module';
import type { StoragePort } from '../ports/storage/storage.port';

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
  type Seg = { id: string; s3Key: string; retentionUntil: Date | null };
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
   * que los tests verifiquen paginación y batching reales (no N deletes por fila).
   */
  function makePrisma(segments: Seg[]) {
    const deleted: string[] = [];
    const findManyCalls: FindManyArgs[] = [];
    const deleteManyBatches: string[][] = [];

    const prisma = {
      read: {
        mediaSegment: {
          findMany: async (args: FindManyArgs): Promise<Pick<Seg, 'id' | 's3Key'>[]> => {
            findManyCalls.push(args);
            const due = segments
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
              .map((s) => ({ id: s.id, s3Key: s.s3Key }));
          },
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
      deleteObject: async (key: string): Promise<void> => {
        if (key === 'recordings/t/boom.mp4') {
          throw new Error('S3 caído para este objeto');
        }
      },
    };
    const sweeper = new RetentionSweeper(prisma as never, flakyStorage, fakeRedis as never);

    const purged = await sweeper.sweep(now);

    // 'boom' falló en S3 → no entra a la fila a borrar; nunca se borra una fila cuyo objeto sigue vivo.
    expect(purged).toBe(2);
    expect(deleted.sort()).toEqual(['ok-1', 'ok-2']);
    expect(deleted).not.toContain('boom');
    // El batch de DB excluye el id fallido (deleteMany de los OK, no de los 3).
    expect(deleteManyBatches).toEqual([['ok-1', 'ok-2']]);
  });
});
