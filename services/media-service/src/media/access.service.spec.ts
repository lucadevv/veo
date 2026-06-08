import { describe, it, expect } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ConflictError, NotFoundError, ValidationError } from '@veo/utils';
import { AccessService } from './access.service';
import { StorageSandboxAdapter } from '../ports/storage/storage.module';
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
  approvedBy: string | null;
  approvedAt: Date | null;
  signedUrlExpiresAt: Date | null;
  watermark: string | null;
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

describe('AccessService.requestAccess · validación de motivo (BR-S02)', () => {
  it('rechaza un motivo de 20 caracteres o menos', async () => {
    const svc = new AccessService(makePrisma([segment()], []) as never, new StorageSandboxAdapter(), config);
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

  it('crea la solicitud cuando el motivo supera los 20 caracteres', async () => {
    const reqs: AccessRequest[] = [];
    const svc = new AccessService(makePrisma([segment()], reqs) as never, new StorageSandboxAdapter(), config);
    const res = await svc.requestAccess({
      tripId: 'trip-1',
      segmentId: 'seg-1',
      requestedBy: 'op-1',
      requestedByEmail: 'op@veo.pe',
      reason: 'Investigación formal de queja del pasajero por conducta del conductor',
    });
    expect(res.status).toBe('PENDING');
    expect(reqs).toHaveLength(1);
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

describe('AccessService.approveAccess · doble autorización + watermark + URL 5 min (BR-S02)', () => {
  const now = new Date('2026-05-28T23:30:00.000Z');

  function pendingRequest(): AccessRequest {
    return {
      id: 'req-1',
      tripId: 'trip-1',
      segmentId: 'seg-1',
      requestedBy: 'op-1',
      requestedByEmail: 'ana@veo.pe',
      reason: 'Investigación formal de queja del pasajero por conducta del conductor',
      approvedBy: null,
      approvedAt: null,
      signedUrlExpiresAt: null,
      watermark: null,
    };
  }

  it('genera signed URL válida 5 minutos, watermark con el email y suma accessedCount', async () => {
    const seg = segment();
    const req = pendingRequest();
    const svc = new AccessService(makePrisma([seg], [req]) as never, new StorageSandboxAdapter(), config);

    const res = await svc.approveAccess('req-1', 'compliance-1', now);

    expect(res.signedUrl).toContain('recordings/trip-1/seg-1.mp4');
    expect(res.watermark).toContain('ana@veo.pe');
    expect(res.watermark).toContain('req-1');
    // 5 minutos exactos
    expect(res.expiresAt.getTime() - now.getTime()).toBe(300 * 1000);
    // auditoría: el segmento queda marcado como accedido
    expect(seg.accessedCount).toBe(1);
    expect(seg.lastAccessedAt).toEqual(now);
    // la solicitud queda aprobada por el supervisor
    expect(req.approvedBy).toBe('compliance-1');
    expect(req.approvedAt).toEqual(now);
  });

  it('no permite aprobar dos veces (idempotencia/anti-replay)', async () => {
    const req = { ...pendingRequest(), approvedAt: now, approvedBy: 'compliance-1' };
    const svc = new AccessService(makePrisma([segment()], [req]) as never, new StorageSandboxAdapter(), config);
    await expect(svc.approveAccess('req-1', 'compliance-2', now)).rejects.toBeInstanceOf(ConflictError);
  });

  it('falla si la solicitud no existe', async () => {
    const svc = new AccessService(makePrisma([segment()], []) as never, new StorageSandboxAdapter(), config);
    await expect(svc.approveAccess('nope', 'compliance-1', now)).rejects.toBeInstanceOf(NotFoundError);
  });
});
