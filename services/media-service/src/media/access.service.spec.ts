import { describe, it, expect } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@veo/utils';
import { AccessService } from './access.service';
import { StorageSandboxAdapter } from '../ports/storage/storage.module';
import { VideoAccessStatus } from '../generated/prisma';
import type { Env } from '../config/env.schema';

const config = new ConfigService<Env, true>({ SIGNED_URL_TTL_SECONDS: 300 });

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
      },
    },
  };
  return prisma;
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

describe('AccessService.streamAccess · firma URL + watermark fresco, solo si APPROVED (BR-S02)', () => {
  const now = new Date('2026-05-28T23:45:00.000Z');

  it('firma signed URL (5 min), watermark con el email y suma accessedCount cuando está APPROVED', async () => {
    const seg = segment();
    const req = pendingRequest({
      status: VideoAccessStatus.APPROVED,
      approvedBy: 'compliance-1',
      approvedAt: now,
    });
    const svc = new AccessService(
      makePrisma([seg], [req]) as never,
      new StorageSandboxAdapter(),
      config,
    );

    const res = await svc.streamAccess('req-1', 'compliance-1', now);

    expect(res.signedUrl).toContain('recordings/trip-1/seg-1.mp4');
    expect(res.watermark).toContain('ana@veo.pe');
    expect(res.watermark).toContain('req-1');
    expect(res.segmentId).toBe('seg-1');
    // 5 minutos exactos
    expect(res.expiresAt.getTime() - now.getTime()).toBe(300 * 1000);
    // cada visualización se audita: el segmento queda marcado como accedido
    expect(seg.accessedCount).toBe(1);
    expect(seg.lastAccessedAt).toEqual(now);
    // se persiste la ventana de la última vista
    expect(req.signedUrlExpiresAt).toEqual(res.expiresAt);
    expect(req.watermark).toBe(res.watermark);
  });

  it('cada reproducción incrementa accessedCount (cadena de custodia)', async () => {
    const seg = segment();
    const req = pendingRequest({ status: VideoAccessStatus.APPROVED });
    const svc = new AccessService(
      makePrisma([seg], [req]) as never,
      new StorageSandboxAdapter(),
      config,
    );

    await svc.streamAccess('req-1', 'compliance-1', now);
    await svc.streamAccess('req-1', 'compliance-1', now);

    expect(seg.accessedCount).toBe(2);
  });

  it('rechaza la visualización si la solicitud está PENDING (no aprobada)', async () => {
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

  it('rechaza la visualización si la solicitud está REJECTED', async () => {
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
