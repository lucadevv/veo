/**
 * Tests del Lote 3 (burn-in) con adapters SANDBOX (storage en memoria + watermark passthrough, SIN ffmpeg).
 *
 * EL TEST CRÍTICO (es el lote): PENDING → corre el worker → READY con renderedS3Key → streamAccess presigna
 * la COPIA DERIVADA y JAMÁS el segment.s3Key crudo (se espía StoragePort.presignDownloadUrl).
 */
import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { AccessService, StreamStatus } from './access.service';
import { VideoRenderWorker } from './video-render.worker';
import { PrismaMediaRepository } from './media.repository';
import { StorageSandboxAdapter } from '../ports/storage/storage.module';
import { SandboxWatermarkAdapter } from '../ports/watermark/sandbox-watermark.adapter';
import { VideoAccessStatus, VideoRenderStatus } from '../generated/prisma';
import type { Env } from '../config/env.schema';

const config = new ConfigService<Env, true>({
  SIGNED_URL_TTL_SECONDS: 300,
  WATERMARK_RENDER_INTERVAL_SECONDS: 20,
  WATERMARK_RENDER_BATCH: 3,
  WATERMARK_RENDER_MAX_ATTEMPTS: 3,
  WATERMARK_RENDERED_PREFIX: 'watermarked/',
  WATERMARK_RENDER_LOCK_TTL_SECONDS: 900,
  WATERMARK_RENDER_STALE_SECONDS: 600,
});

// ── Modelos del fake (mínimos pero honestos para el filtro del worker) ────────────────────────────────
interface Seg {
  id: string;
  tripId: string;
  s3Key: string;
  startedAt: Date;
  accessedCount: number;
  lastAccessedAt: Date | null;
}
interface Req {
  id: string;
  tripId: string;
  segmentId: string | null;
  requestedBy: string;
  requestedByEmail: string;
  status: VideoAccessStatus;
  signedUrlExpiresAt: Date | null;
  watermark: string | null;
  renderStatus: VideoRenderStatus | null;
  renderedS3Key: string | null;
  renderRequestedAt: Date | null;
  renderedAt: Date | null;
  renderError: string | null;
  renderAttempts: number;
  createdAt: Date;
}

type Where = Record<string, unknown>;

/** Evaluador del subconjunto de `where` que usan worker + access (renderStatus/attempts/tiempo/OR/in). */
function matchWhere(r: Req, where: Where): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'OR') {
      const ors = v as Where[];
      if (!ors.some((w) => matchWhere(r, w))) return false;
      continue;
    }
    if (k === 'renderRequestedAt') {
      const cond = v as { lt?: Date };
      if (cond.lt !== undefined) {
        if (!(r.renderRequestedAt && r.renderRequestedAt.getTime() < cond.lt.getTime()))
          return false;
      }
      continue;
    }
    if (k === 'renderAttempts') {
      const cond = v as { lt?: number; gte?: number };
      if (cond.lt !== undefined && !(r.renderAttempts < cond.lt)) return false;
      if (cond.gte !== undefined && !(r.renderAttempts >= cond.gte)) return false;
      continue;
    }
    if (k === 'renderedS3Key') {
      const cond = v as { not?: null };
      if ('not' in cond && cond.not === null && r.renderedS3Key === null) return false;
      continue;
    }
    if (k === 'segmentId') {
      const cond = v as { in?: (string | null)[] } | string | null;
      if (cond && typeof cond === 'object' && 'in' in cond) {
        if (!cond.in?.includes(r.segmentId)) return false;
      } else if (r.segmentId !== cond) return false;
      continue;
    }
    // Igualdad simple (id, tripId, status, renderStatus).
    if ((r as unknown as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}

function applyData(target: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as Record<string, unknown>)) {
      target[k] = Number(target[k] ?? 0) + Number((v as { increment: number }).increment);
    } else {
      target[k] = v;
    }
  }
}

interface OutboxRow {
  eventType: string;
  envelope: { eventType: string; payload: Record<string, unknown> };
}

function makePrisma(segments: Seg[], requests: Req[]) {
  const outbox: OutboxRow[] = [];
  const tx = {
    videoAccessRequest: {
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = requests.find((x) => x.id === where.id)!;
        applyData(r as unknown as Record<string, unknown>, data);
        return r;
      },
    },
    mediaSegment: {
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const s = segments.find((x) => x.id === where.id)!;
        applyData(s as unknown as Record<string, unknown>, data);
        return s;
      },
    },
    outboxEvent: {
      create: async ({ data }: { data: OutboxRow }) => {
        outbox.push(data);
        return data;
      },
    },
  };
  const prisma = {
    read: {
      mediaSegment: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          segments.find((s) => s.id === where.id) ?? null,
        findFirst: async ({ where }: { where: { tripId: string } }) =>
          segments.filter((s) => s.tripId === where.tripId)[0] ?? null,
      },
      videoAccessRequest: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          requests.find((r) => r.id === where.id) ?? null,
        findMany: async (args: {
          where: Where;
          orderBy?: { renderRequestedAt?: 'asc' };
          take?: number;
        }) => {
          let rows = requests.filter((r) => matchWhere(r, args.where));
          if (args.orderBy?.renderRequestedAt === 'asc') {
            rows = [...rows].sort(
              (a, b) =>
                (a.renderRequestedAt?.getTime() ?? 0) - (b.renderRequestedAt?.getTime() ?? 0),
            );
          }
          return typeof args.take === 'number' ? rows.slice(0, args.take) : rows;
        },
      },
    },
    write: {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      videoAccessRequest: {
        update: tx.videoAccessRequest.update,
        updateMany: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
          const matched = requests.filter((r) => matchWhere(r, where));
          for (const r of matched) applyData(r as unknown as Record<string, unknown>, data);
          return { count: matched.length };
        },
        findMany: async ({ where }: { where: Where }) =>
          requests.filter((r) => matchWhere(r, where)),
      },
    },
  };
  return { prisma, outbox };
}

function segment(over: Partial<Seg> = {}): Seg {
  return {
    id: 'seg-1',
    tripId: 'trip-1',
    s3Key: 'recordings/trip-1/seg-1.mp4',
    startedAt: new Date('2026-05-28T20:00:00.000Z'),
    accessedCount: 0,
    lastAccessedAt: null,
    ...over,
  };
}

function request(over: Partial<Req> = {}): Req {
  return {
    id: 'req-1',
    tripId: 'trip-1',
    segmentId: 'seg-1',
    requestedBy: 'op-1',
    requestedByEmail: 'ana@veo.pe',
    status: VideoAccessStatus.APPROVED,
    signedUrlExpiresAt: null,
    watermark: null,
    renderStatus: VideoRenderStatus.PENDING,
    renderedS3Key: null,
    renderRequestedAt: new Date('2026-05-28T23:00:00.000Z'),
    renderedAt: null,
    renderError: null,
    renderAttempts: 0,
    createdAt: new Date('2026-05-28T22:00:00.000Z'),
    ...over,
  };
}

const fakeRedis = { set: async () => 'OK', del: async () => 1 };
const fakeScheduler = { addInterval: () => undefined, deleteInterval: () => undefined };

function makeWorker(
  prisma: ReturnType<typeof makePrisma>['prisma'],
  storage: StorageSandboxAdapter,
  watermark: SandboxWatermarkAdapter,
): VideoRenderWorker {
  return new VideoRenderWorker(
    new PrismaMediaRepository(prisma as never),
    storage,
    watermark,
    fakeRedis as never,
    fakeScheduler as never,
    config,
  );
}

describe('VideoRenderWorker + streamAccess · burn-in end-to-end (EL TEST CRÍTICO del lote)', () => {
  const now = new Date('2026-05-29T00:00:00.000Z');

  it('PENDING → worker rinde → READY con renderedS3Key → streamAccess presigna la COPIA, NUNCA el crudo', async () => {
    const seg = segment();
    const req = request({ renderStatus: VideoRenderStatus.PENDING });
    const { prisma, outbox } = makePrisma([seg], [req]);
    const storage = new StorageSandboxAdapter();
    const watermark = new SandboxWatermarkAdapter();
    // El video CRUDO existe en el store (si no, getObjectStream lanzaría NotFound).
    await storage.uploadObject({
      key: seg.s3Key,
      body: Buffer.from('crudo-de-cabina'),
      contentType: 'video/mp4',
    });

    // 1) corre el worker: rinde el PENDING.
    const worker = makeWorker(prisma, storage, watermark);
    const processed = await worker.processBatch(now);

    expect(processed).toBe(1);
    expect(req.renderStatus).toBe(VideoRenderStatus.READY);
    expect(req.renderedS3Key).toBe('watermarked/req-1.mp4');
    expect(req.renderedAt).toEqual(now);
    expect(req.renderAttempts).toBe(1); // el worker incrementó al TOMARLA
    // el watermark quemado se compuso con el operador + requestId (passthrough lo expone)
    expect(watermark.lastBurnText).toContain('ana@veo.pe');
    expect(watermark.lastBurnText).toContain('req-1');
    // evento de auditoría SIN PII (sin email/watermark crudo)
    const completed = outbox.find((o) => o.envelope.eventType === 'media.render_completed');
    expect(completed).toBeDefined();
    expect(completed?.envelope.payload).toMatchObject({ requestId: 'req-1', segmentId: 'seg-1' });
    expect(JSON.stringify(completed?.envelope.payload)).not.toContain('ana@veo.pe');

    // 2) streamAccess sirve la copia: presigna renderedS3Key, NUNCA segment.s3Key.
    const presignSpy = vi.spyOn(storage, 'presignDownloadUrl');
    const access = new AccessService(
      new PrismaMediaRepository(prisma as never),
      storage,
      new ConfigService<Env, true>({
        SIGNED_URL_TTL_SECONDS: 300,
        WATERMARK_RENDER_MAX_ATTEMPTS: 3,
      }),
    );
    const res = await access.streamAccess('req-1', 'compliance-1', now);

    expect(res.status).toBe(StreamStatus.READY);
    if (res.status !== StreamStatus.READY) throw new Error('esperaba READY');
    expect(presignSpy).toHaveBeenCalledTimes(1);
    // EL INVARIANTE: la key firmada es la COPIA derivada, jamás el crudo.
    expect(presignSpy.mock.calls[0]?.[0]?.key).toBe('watermarked/req-1.mp4');
    expect(presignSpy.mock.calls[0]?.[0]?.key).not.toBe(seg.s3Key);
    expect(res.signedUrl).toContain('watermarked/req-1.mp4');
    expect(res.signedUrl).not.toContain('recordings/trip-1/seg-1.mp4');
    expect(seg.accessedCount).toBe(1);
  });
});

describe('VideoRenderWorker.processBatch · máquina de estados del render', () => {
  const now = new Date('2026-05-29T00:00:00.000Z');

  async function withRawVideo(storage: StorageSandboxAdapter, key: string): Promise<void> {
    await storage.uploadObject({ key, body: Buffer.from('crudo'), contentType: 'video/mp4' });
  }

  it('happy: PENDING → READY (1 intento) + evento render_completed', async () => {
    const seg = segment();
    const req = request({ renderStatus: VideoRenderStatus.PENDING });
    const { prisma, outbox } = makePrisma([seg], [req]);
    const storage = new StorageSandboxAdapter();
    await withRawVideo(storage, seg.s3Key);

    await makeWorker(prisma, storage, new SandboxWatermarkAdapter()).processBatch(now);

    expect(req.renderStatus).toBe(VideoRenderStatus.READY);
    expect(req.renderAttempts).toBe(1);
    expect(outbox.some((o) => o.envelope.eventType === 'media.render_completed')).toBe(true);
  });

  it('falla el burn: PENDING → FAILED, attempts++ y evento render_failed (sin PII)', async () => {
    const seg = segment();
    const req = request({ renderStatus: VideoRenderStatus.PENDING });
    const { prisma, outbox } = makePrisma([seg], [req]);
    const storage = new StorageSandboxAdapter();
    await withRawVideo(storage, seg.s3Key);
    // watermark que explota (motor de video caído).
    const boom = new SandboxWatermarkAdapter();
    vi.spyOn(boom, 'burn').mockRejectedValue(new Error('ffmpeg murió'));

    await makeWorker(prisma, storage, boom).processBatch(now);

    expect(req.renderStatus).toBe(VideoRenderStatus.FAILED);
    expect(req.renderAttempts).toBe(1);
    expect(req.renderError).toBeTruthy();
    const failed = outbox.find((o) => o.envelope.eventType === 'media.render_failed');
    expect(failed).toBeDefined();
    expect(failed?.envelope.payload).toMatchObject({ requestId: 'req-1' });
    // reason es categoría técnica, sin email/watermark
    expect(JSON.stringify(failed?.envelope.payload)).not.toContain('ana@veo.pe');
  });

  it('fuente inexistente: PENDING → FAILED con reason SOURCE_NOT_FOUND', async () => {
    const seg = segment();
    const req = request({ renderStatus: VideoRenderStatus.PENDING });
    const { prisma, outbox } = makePrisma([seg], [req]);
    // NO se sube el crudo → getObjectStream lanza NotFound.
    await makeWorker(
      prisma,
      new StorageSandboxAdapter(),
      new SandboxWatermarkAdapter(),
    ).processBatch(now);

    expect(req.renderStatus).toBe(VideoRenderStatus.FAILED);
    const failed = outbox.find((o) => o.envelope.eventType === 'media.render_failed');
    expect(failed?.envelope.payload.reason).toBe('SOURCE_NOT_FOUND');
  });

  it('REAPER: PROCESSING COLGADO (renderRequestedAt viejo) se re-toma y completa', async () => {
    const seg = segment();
    // PROCESSING con renderRequestedAt muy viejo (> stale 600s) y attempts < cap → colgado, reaper lo retoma.
    const req = request({
      renderStatus: VideoRenderStatus.PROCESSING,
      renderRequestedAt: new Date('2026-05-28T00:00:00.000Z'),
      renderAttempts: 1,
    });
    const { prisma } = makePrisma([seg], [req]);
    const storage = new StorageSandboxAdapter();
    await withRawVideo(storage, seg.s3Key);

    const processed = await makeWorker(prisma, storage, new SandboxWatermarkAdapter()).processBatch(
      now,
    );

    expect(processed).toBe(1);
    expect(req.renderStatus).toBe(VideoRenderStatus.READY);
    expect(req.renderAttempts).toBe(2); // re-toma → incrementa
  });

  it('REAPER terminal: PROCESSING colgado con intentos agotados → FAILED (no se re-toma)', async () => {
    const seg = segment();
    const req = request({
      renderStatus: VideoRenderStatus.PROCESSING,
      renderRequestedAt: new Date('2026-05-28T00:00:00.000Z'),
      renderAttempts: 3, // = cap
    });
    const { prisma } = makePrisma([seg], [req]);
    const storage = new StorageSandboxAdapter();
    await withRawVideo(storage, seg.s3Key);

    const processed = await makeWorker(prisma, storage, new SandboxWatermarkAdapter()).processBatch(
      now,
    );

    expect(processed).toBe(0); // no se rindió: el reaper lo marcó terminal
    expect(req.renderStatus).toBe(VideoRenderStatus.FAILED);
    expect(req.renderAttempts).toBe(3); // intacto (no re-toma)
  });

  it('PROCESSING reciente (no colgado) NO se toca', async () => {
    const seg = segment();
    const req = request({
      renderStatus: VideoRenderStatus.PROCESSING,
      renderRequestedAt: new Date('2026-05-28T23:59:30.000Z'), // 30s atrás < stale 600s
      renderAttempts: 1,
    });
    const { prisma } = makePrisma([seg], [req]);

    const processed = await makeWorker(
      prisma,
      new StorageSandboxAdapter(),
      new SandboxWatermarkAdapter(),
    ).processBatch(now);

    expect(processed).toBe(0);
    expect(req.renderStatus).toBe(VideoRenderStatus.PROCESSING);
    expect(req.renderAttempts).toBe(1);
  });
});
