import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import {
  ConflictError,
  ExternalServiceError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@veo/utils';
import { AccessService, StreamStatus } from './access.service';
import { StorageSandboxAdapter } from '../ports/storage/storage.module';
import { VideoAccessStatus, VideoRenderStatus } from '../generated/prisma';
import type { Env } from '../config/env.schema';

const config = new ConfigService<Env, true>({
  SIGNED_URL_TTL_SECONDS: 300,
  WATERMARK_RENDER_MAX_ATTEMPTS: 3,
});

interface Segment {
  id: string;
  tripId: string;
  s3Key: string;
  startedAt: Date;
  accessedCount: number;
  lastAccessedAt: Date | null;
}
interface AccessRequest {
  id: string;
  tripId: string;
  segmentId: string | null;
  requestedBy: string;
  requestedByEmail: string;
  reason: string;
  status: VideoAccessStatus;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectedBy: string | null;
  rejectedAt: Date | null;
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

function applyUpdate(target: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as Record<string, unknown>)) {
      target[k] = Number(target[k] ?? 0) + Number((v as { increment: number }).increment);
    } else {
      target[k] = v;
    }
  }
}

function makePrisma(segments: Segment[], requests: AccessRequest[]) {
  const tx = {
    videoAccessRequest: {
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = requests.find((x) => x.id === where.id)!;
        applyUpdate(r as unknown as Record<string, unknown>, data);
        return r;
      },
    },
    mediaSegment: {
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const s = segments.find((x) => x.id === where.id)!;
        applyUpdate(s as unknown as Record<string, unknown>, data);
        return s;
      },
    },
    outboxEvent: { create: async () => ({}) },
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
        findMany: async ({ where }: { where?: { status?: VideoAccessStatus } } = {}) => {
          const filtered = where?.status
            ? requests.filter((r) => r.status === where.status)
            : [...requests];
          return filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        },
      },
    },
    write: {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      videoAccessRequest: {
        create: async ({ data }: { data: AccessRequest }) => {
          requests.push({ ...data });
          return data;
        },
        // UPDATE CONDICIONAL del re-disparo de render (FIX lost-update): aplica `data` SOLO si la fila VIVA
        // matchea la guarda `OR` (renderStatus null | FAILED&attempts<cap). Modela el guard atómico de
        // Prisma evaluando contra el ESTADO ACTUAL del store, no contra el snapshot leído por streamAccess.
        updateMany: async ({ where, data }: UpdateManyArgs): Promise<{ count: number }> => {
          const r = requests.find((x) => x.id === where.id);
          if (!r) return { count: 0 };
          const matches =
            !where.OR ||
            where.OR.some((cond) => {
              const statusOk = !('renderStatus' in cond) || r.renderStatus === cond.renderStatus;
              const attemptsOk =
                cond.renderAttempts === undefined || r.renderAttempts < cond.renderAttempts.lt;
              return statusOk && attemptsOk;
            });
          if (!matches) return { count: 0 };
          applyUpdate(r as unknown as Record<string, unknown>, data);
          return { count: 1 };
        },
      },
    },
  };
  return prisma;
}

/** Guarda condicional del re-disparo de render (espeja el WHERE del updateMany de streamAccess). */
interface RenderGuard {
  renderStatus?: VideoRenderStatus | null;
  renderAttempts?: { lt: number };
}
interface UpdateManyArgs {
  where: { id: string; OR?: RenderGuard[] };
  data: Record<string, unknown>;
}

function segment(over: Partial<Segment> = {}): Segment {
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

function pendingRequest(over: Partial<AccessRequest> = {}): AccessRequest {
  return {
    id: 'req-1',
    tripId: 'trip-1',
    segmentId: 'seg-1',
    requestedBy: 'op-1',
    requestedByEmail: 'ana@veo.pe',
    reason: 'Investigación formal de queja del pasajero por conducta del conductor',
    status: VideoAccessStatus.PENDING,
    approvedBy: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedAt: null,
    signedUrlExpiresAt: null,
    watermark: null,
    renderStatus: null,
    renderedS3Key: null,
    renderRequestedAt: null,
    renderedAt: null,
    renderError: null,
    renderAttempts: 0,
    createdAt: new Date('2026-05-28T22:00:00.000Z'),
    ...over,
  };
}

describe('AccessService.requestAccess · validación de motivo (BR-S02)', () => {
  it('rechaza un motivo de 20 caracteres o menos', async () => {
    const svc = new AccessService(
      makePrisma([segment()], []) as never,
      new StorageSandboxAdapter(),
      config,
    );
    await expect(
      svc.requestAccess({
        tripId: 'trip-1',
        segmentId: 'seg-1',
        requestedBy: 'op-1',
        requestedByEmail: 'op@veo.pe',
        reason: 'corto', // < 20
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('crea la solicitud en estado PENDING cuando el motivo supera los 20 caracteres', async () => {
    const reqs: AccessRequest[] = [];
    const svc = new AccessService(
      makePrisma([segment()], reqs) as never,
      new StorageSandboxAdapter(),
      config,
    );
    const res = await svc.requestAccess({
      tripId: 'trip-1',
      segmentId: 'seg-1',
      requestedBy: 'op-1',
      requestedByEmail: 'op@veo.pe',
      reason: 'Investigación formal de queja del pasajero por conducta del conductor',
    });
    expect(res.status).toBe(VideoAccessStatus.PENDING);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.status).toBe(VideoAccessStatus.PENDING);
  });

  it('falla si no hay video para el viaje', async () => {
    const svc = new AccessService(makePrisma([], []) as never, new StorageSandboxAdapter(), config);
    await expect(
      svc.requestAccess({
        tripId: 'trip-x',
        requestedBy: 'op-1',
        requestedByEmail: 'op@veo.pe',
        reason: 'Motivo suficientemente largo para pasar la validación de longitud',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('AccessService.approveAccess · transición de estado PENDING → APPROVED (BR-S02)', () => {
  const now = new Date('2026-05-28T23:30:00.000Z');

  it('aprueba: marca APPROVED + approvedBy + approvedAt, sin firmar URL ni tocar el segmento', async () => {
    const seg = segment();
    const req = pendingRequest();
    const svc = new AccessService(
      makePrisma([seg], [req]) as never,
      new StorageSandboxAdapter(),
      config,
    );

    const res = await svc.approveAccess('req-1', 'compliance-1', now);

    expect(res.status).toBe(VideoAccessStatus.APPROVED);
    expect(res.approvedBy).toBe('compliance-1');
    expect(res.approvedAt).toEqual(now);
    // approve ya NO firma URL ni incrementa accessedCount
    expect(req.signedUrlExpiresAt).toBeNull();
    expect(req.watermark).toBeNull();
    expect(seg.accessedCount).toBe(0);
  });

  it('no permite aprobar una solicitud ya decidida (guard de transición)', async () => {
    const req = pendingRequest({
      status: VideoAccessStatus.APPROVED,
      approvedBy: 'compliance-1',
      approvedAt: now,
    });
    const svc = new AccessService(
      makePrisma([segment()], [req]) as never,
      new StorageSandboxAdapter(),
      config,
    );
    await expect(svc.approveAccess('req-1', 'compliance-2', now)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('no permite aprobar una solicitud rechazada', async () => {
    const req = pendingRequest({
      status: VideoAccessStatus.REJECTED,
      rejectedBy: 'compliance-1',
      rejectedAt: now,
    });
    const svc = new AccessService(
      makePrisma([segment()], [req]) as never,
      new StorageSandboxAdapter(),
      config,
    );
    await expect(svc.approveAccess('req-1', 'compliance-2', now)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('falla si la solicitud no existe', async () => {
    const svc = new AccessService(
      makePrisma([segment()], []) as never,
      new StorageSandboxAdapter(),
      config,
    );
    await expect(svc.approveAccess('nope', 'compliance-1', now)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('AccessService.rejectAccess · transición de estado PENDING → REJECTED (BR-S02)', () => {
  const now = new Date('2026-05-28T23:30:00.000Z');

  it('rechaza: marca REJECTED + rejectedBy + rejectedAt', async () => {
    const req = pendingRequest();
    const svc = new AccessService(
      makePrisma([segment()], [req]) as never,
      new StorageSandboxAdapter(),
      config,
    );

    const res = await svc.rejectAccess('req-1', 'compliance-1', now);

    expect(res.status).toBe(VideoAccessStatus.REJECTED);
    expect(res.rejectedBy).toBe('compliance-1');
    expect(res.rejectedAt).toEqual(now);
  });

  it('no permite rechazar una solicitud ya decidida (guard de transición)', async () => {
    const req = pendingRequest({
      status: VideoAccessStatus.APPROVED,
      approvedBy: 'compliance-1',
      approvedAt: now,
    });
    const svc = new AccessService(
      makePrisma([segment()], [req]) as never,
      new StorageSandboxAdapter(),
      config,
    );
    await expect(svc.rejectAccess('req-1', 'compliance-2', now)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('falla si la solicitud no existe', async () => {
    const svc = new AccessService(
      makePrisma([segment()], []) as never,
      new StorageSandboxAdapter(),
      config,
    );
    await expect(svc.rejectAccess('nope', 'compliance-1', now)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('AccessService.streamAccess · burn-in: presigna SOLO la copia derivada, nunca el crudo (BR-S02)', () => {
  const now = new Date('2026-05-28T23:45:00.000Z');

  it('READY: presigna renderedS3Key (NUNCA segment.s3Key), audita la vista y suma accessedCount', async () => {
    const seg = segment();
    const req = pendingRequest({
      status: VideoAccessStatus.APPROVED,
      renderStatus: VideoRenderStatus.READY,
      renderedS3Key: 'watermarked/req-1.mp4',
      watermark: 'VEO · ana@veo.pe · req-1 · 2026-05-28T23:40:00.000Z',
    });
    const storage = new StorageSandboxAdapter();
    const presignSpy = vi.spyOn(storage, 'presignDownloadUrl');
    const svc = new AccessService(makePrisma([seg], [req]) as never, storage, config);

    const res = await svc.streamAccess('req-1', 'compliance-1', now);

    expect(res.status).toBe(StreamStatus.READY);
    if (res.status !== StreamStatus.READY) throw new Error('esperaba READY');
    // INVARIANTE DE SEGURIDAD: se firmó la COPIA derivada, jamás el crudo.
    expect(presignSpy).toHaveBeenCalledTimes(1);
    expect(presignSpy.mock.calls[0]?.[0]?.key).toBe('watermarked/req-1.mp4');
    expect(presignSpy.mock.calls[0]?.[0]?.key).not.toBe(seg.s3Key);
    expect(res.signedUrl).toContain('watermarked/req-1.mp4');
    expect(res.signedUrl).not.toContain('recordings/trip-1/seg-1.mp4');
    // watermark = el texto YA quemado (persistido), no recomputado
    expect(res.watermark).toBe('VEO · ana@veo.pe · req-1 · 2026-05-28T23:40:00.000Z');
    expect(res.segmentId).toBe('seg-1');
    expect(res.expiresAt.getTime() - now.getTime()).toBe(300 * 1000);
    // cada visualización se audita: el segmento queda marcado como accedido
    expect(seg.accessedCount).toBe(1);
    expect(seg.lastAccessedAt).toEqual(now);
    expect(req.signedUrlExpiresAt).toEqual(res.expiresAt);
  });

  it('render NUNCA pedido (null): devuelve PROCESSING, marca PENDING y NO presigna nada', async () => {
    const req = pendingRequest({ status: VideoAccessStatus.APPROVED, renderStatus: null });
    const storage = new StorageSandboxAdapter();
    const presignSpy = vi.spyOn(storage, 'presignDownloadUrl');
    const svc = new AccessService(makePrisma([segment()], [req]) as never, storage, config);

    const res = await svc.streamAccess('req-1', 'compliance-1', now);

    expect(res.status).toBe(StreamStatus.PROCESSING);
    expect(presignSpy).not.toHaveBeenCalled();
    // disparó el worker lazy: PENDING + renderRequestedAt sellado; attempts NO se toca acá
    expect(req.renderStatus).toBe(VideoRenderStatus.PENDING);
    expect(req.renderRequestedAt).toEqual(now);
    expect(req.renderAttempts).toBe(0);
  });

  it('CONCURRENCIA (lost-update): si el worker deja READY entre el read y el update, NO clobberea READY→PENDING', async () => {
    // Fila VIVA: el worker YA la dejó READY con su copia (renderAttempts=1).
    const liveRow = pendingRequest({
      status: VideoAccessStatus.APPROVED,
      renderStatus: VideoRenderStatus.READY,
      renderedS3Key: 'watermarked/req-1.mp4',
      renderAttempts: 1,
    });
    // Snapshot STALE que ve streamAccess en su findUnique: leyó el render como `null` ANTES de que el worker
    // terminara. El update INCONDICIONAL viejo habría pisado el READY de la fila viva con un PENDING espurio.
    const staleSnapshot: AccessRequest = { ...liveRow, renderStatus: null, renderedS3Key: null };
    const storage = new StorageSandboxAdapter();
    const presignSpy = vi.spyOn(storage, 'presignDownloadUrl');
    const prisma = {
      read: {
        videoAccessRequest: { findUnique: async () => staleSnapshot },
        mediaSegment: { findUnique: async () => segment(), findFirst: async () => segment() },
      },
      write: {
        videoAccessRequest: {
          // El guard CONDICIONAL evalúa contra la fila VIVA (READY) → NO matchea (excluye READY) → count 0.
          updateMany: async ({ where }: UpdateManyArgs): Promise<{ count: number }> => {
            const matches = (where.OR ?? []).some(
              (c) =>
                (!('renderStatus' in c) || liveRow.renderStatus === c.renderStatus) &&
                (c.renderAttempts === undefined || liveRow.renderAttempts < c.renderAttempts.lt),
            );
            if (matches) {
              liveRow.renderStatus = VideoRenderStatus.PENDING;
              return { count: 1 };
            }
            return { count: 0 };
          },
        },
      },
    };
    const svc = new AccessService(prisma as never, storage, config);

    const res = await svc.streamAccess('req-1', 'compliance-1', now);

    expect(res.status).toBe(StreamStatus.PROCESSING);
    // El READY de la fila viva NO fue pisado por un PENDING espurio (la carrera está cerrada).
    expect(liveRow.renderStatus).toBe(VideoRenderStatus.READY);
    expect(presignSpy).not.toHaveBeenCalled();
  });

  it('PENDING / PROCESSING: PROCESSING idempotente, no re-dispara ni presigna', async () => {
    const storage = new StorageSandboxAdapter();
    const presignSpy = vi.spyOn(storage, 'presignDownloadUrl');
    const requestedAt = new Date('2026-05-28T23:00:00.000Z');

    for (const status of [VideoRenderStatus.PENDING, VideoRenderStatus.PROCESSING]) {
      const req = pendingRequest({
        status: VideoAccessStatus.APPROVED,
        renderStatus: status,
        renderRequestedAt: requestedAt,
        renderAttempts: 1,
      });
      const svc = new AccessService(makePrisma([segment()], [req]) as never, storage, config);

      const res = await svc.streamAccess('req-1', 'compliance-1', now);

      expect(res.status).toBe(StreamStatus.PROCESSING);
      // idempotente: no re-sella renderRequestedAt ni toca attempts
      expect(req.renderStatus).toBe(status);
      expect(req.renderRequestedAt).toEqual(requestedAt);
      expect(req.renderAttempts).toBe(1);
    }
    expect(presignSpy).not.toHaveBeenCalled();
  });

  it('FAILED con intentos disponibles: re-dispara (PROCESSING + PENDING)', async () => {
    const req = pendingRequest({
      status: VideoAccessStatus.APPROVED,
      renderStatus: VideoRenderStatus.FAILED,
      renderAttempts: 1, // < cap (3)
      renderError: 'STORAGE_OR_RENDER_FAILED',
    });
    const svc = new AccessService(
      makePrisma([segment()], [req]) as never,
      new StorageSandboxAdapter(),
      config,
    );

    const res = await svc.streamAccess('req-1', 'compliance-1', now);

    expect(res.status).toBe(StreamStatus.PROCESSING);
    expect(req.renderStatus).toBe(VideoRenderStatus.PENDING);
    expect(req.renderRequestedAt).toEqual(now);
  });

  it('FAILED con intentos agotados (≥ cap): error TIPADO, no loop infinito de PROCESSING', async () => {
    const req = pendingRequest({
      status: VideoAccessStatus.APPROVED,
      renderStatus: VideoRenderStatus.FAILED,
      renderAttempts: 3, // = cap
    });
    const svc = new AccessService(
      makePrisma([segment()], [req]) as never,
      new StorageSandboxAdapter(),
      config,
    );
    await expect(svc.streamAccess('req-1', 'compliance-1', now)).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
  });

  it('rechaza la visualización si la DECISIÓN está PENDING (no aprobada)', async () => {
    const req = pendingRequest({ status: VideoAccessStatus.PENDING });
    const svc = new AccessService(
      makePrisma([segment()], [req]) as never,
      new StorageSandboxAdapter(),
      config,
    );
    await expect(svc.streamAccess('req-1', 'compliance-1', now)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('rechaza la visualización si la DECISIÓN está REJECTED', async () => {
    const req = pendingRequest({ status: VideoAccessStatus.REJECTED });
    const svc = new AccessService(
      makePrisma([segment()], [req]) as never,
      new StorageSandboxAdapter(),
      config,
    );
    await expect(svc.streamAccess('req-1', 'compliance-1', now)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('falla si la solicitud no existe', async () => {
    const svc = new AccessService(
      makePrisma([segment()], []) as never,
      new StorageSandboxAdapter(),
      config,
    );
    await expect(svc.streamAccess('nope', 'compliance-1', now)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('AccessService.listAccessRequests · filtro por estado, orden createdAt desc (BR-S02)', () => {
  it('devuelve todas ordenadas por createdAt desc cuando no hay filtro', async () => {
    const older = pendingRequest({
      id: 'req-old',
      createdAt: new Date('2026-05-28T10:00:00.000Z'),
    });
    const newer = pendingRequest({
      id: 'req-new',
      createdAt: new Date('2026-05-28T12:00:00.000Z'),
    });
    const svc = new AccessService(
      makePrisma([segment()], [older, newer]) as never,
      new StorageSandboxAdapter(),
      config,
    );

    const res = await svc.listAccessRequests();

    expect(res.map((r) => r.id)).toEqual(['req-new', 'req-old']);
  });

  it('filtra por estado cuando se provee', async () => {
    const pending = pendingRequest({ id: 'req-p', status: VideoAccessStatus.PENDING });
    const approved = pendingRequest({ id: 'req-a', status: VideoAccessStatus.APPROVED });
    const svc = new AccessService(
      makePrisma([segment()], [pending, approved]) as never,
      new StorageSandboxAdapter(),
      config,
    );

    const res = await svc.listAccessRequests({ status: VideoAccessStatus.APPROVED });

    expect(res).toHaveLength(1);
    expect(res[0]!.id).toBe('req-a');
  });
});
