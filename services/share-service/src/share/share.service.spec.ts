/**
 * ShareService — pertenencia FALLA-CERRADO de createLink/revoke (anti-IDOR).
 * El passengerId del snapshot llega por trip.started / panic.triggered; sin él NO se puede
 * verificar al dueño y se deniega (nunca se asume ownership por ausencia de datos).
 */
import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ForbiddenError, UnprocessableEntityError } from '@veo/utils';
import { ShareService } from './share.service';
import type { Env } from '../config/env.schema';

const config = new ConfigService<Env, true>({
  SHARE_LINK_SECRET: 'test-secret',
  SHARE_LINK_TTL_SECONDS: 3600,
  SHARE_LINK_MAX_USES: 10,
  SHARE_PUBLIC_BASE_URL: 'https://veo.pe/f',
});

interface SnapshotStub {
  tripId: string;
  passengerId: string | null;
}

interface LinkStub {
  id: string;
  tripId: string;
  contactId: string | null;
  expiresAt: Date;
  maxUses: number;
  revokedAt: Date | null;
}

function makePrisma(opts: { snapshot?: SnapshotStub | null; link?: LinkStub | null } = {}) {
  const tx = {
    shareLink: { create: vi.fn(async () => undefined), update: vi.fn(async () => undefined) },
    outboxEvent: { create: vi.fn(async () => undefined) },
  };
  return {
    tx,
    read: {
      tripSnapshot: { findUnique: vi.fn(async () => opts.snapshot ?? null) },
      shareLink: { findUnique: vi.fn(async () => opts.link ?? null) },
      trustedContact: { findUnique: vi.fn(async () => null) },
    },
    write: {
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
      shareLink: {
        update: vi.fn(async () => undefined),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    },
  };
}

function makeLink(overrides: Partial<LinkStub> = {}): LinkStub {
  return {
    id: 'share-1',
    tripId: 'trip-1',
    contactId: null,
    expiresAt: new Date(Date.now() + 3_600_000),
    maxUses: 10,
    revokedAt: null,
    ...overrides,
  };
}

describe('ShareService.createLink · pertenencia falla-cerrado', () => {
  it('sin snapshot del viaje → deniega con UnprocessableEntityError (no asume ownership)', async () => {
    const prisma = makePrisma({ snapshot: null });
    const svc = new ShareService(prisma as never, config);

    await expect(svc.createLink('u1', 'trip-1')).rejects.toBeInstanceOf(UnprocessableEntityError);
    expect(prisma.write.$transaction).not.toHaveBeenCalled();
  });

  it('snapshot sin passengerId proyectado → deniega con UnprocessableEntityError', async () => {
    const prisma = makePrisma({ snapshot: { tripId: 'trip-1', passengerId: null } });
    const svc = new ShareService(prisma as never, config);

    await expect(svc.createLink('u1', 'trip-1')).rejects.toBeInstanceOf(UnprocessableEntityError);
    expect(prisma.write.$transaction).not.toHaveBeenCalled();
  });

  it('passengerId distinto del solicitante → ForbiddenError (IDOR bloqueado)', async () => {
    const prisma = makePrisma({ snapshot: { tripId: 'trip-1', passengerId: 'owner-1' } });
    const svc = new ShareService(prisma as never, config);

    await expect(svc.createLink('attacker', 'trip-1')).rejects.toBeInstanceOf(ForbiddenError);
    expect(prisma.write.$transaction).not.toHaveBeenCalled();
  });

  it('dueño legítimo → crea el enlace y devuelve el token una única vez', async () => {
    const prisma = makePrisma({ snapshot: { tripId: 'trip-1', passengerId: 'owner-1' } });
    const svc = new ShareService(prisma as never, config);

    const res = await svc.createLink('owner-1', 'trip-1');

    expect(res.tripId).toBe('trip-1');
    expect(res.deduped).toBe(false);
    expect(res.token).not.toBe('');
    expect(res.url).toContain(res.token);
    expect(prisma.tx.shareLink.create).toHaveBeenCalledOnce();
    expect(prisma.tx.outboxEvent.create).toHaveBeenCalledOnce(); // share.link_generated en la MISMA tx
  });
});

describe('ShareService.createPanicFanout · delega el fan-out durable (B1, anti-PII)', () => {
  const panic = {
    panicId: 'pn-1',
    passengerId: 'pax-1',
    geo: { lat: -12.04, lon: -77.04 },
    contactIds: ['c1', 'c2'],
  };
  const ttl = { ttlSeconds: 3600, maxUses: 50 };

  it('crea EL enlace y encola panic.fanout_requested (SOLO IDs + deep-link, CERO PII)', async () => {
    const prisma = makePrisma({ link: null });
    const svc = new ShareService(prisma as never, config);

    const res = await svc.createPanicFanout('trip-1', panic, ttl);

    expect(res.emitted).toBe(true);
    expect(res.url).toContain('https://veo.pe/f/');
    expect(prisma.tx.shareLink.create).toHaveBeenCalledOnce();
    // Dos eventos en la MISMA tx: share.link_generated + panic.fanout_requested.
    expect(prisma.tx.outboxEvent.create).toHaveBeenCalledTimes(2);

    type OutboxArg = { data: { eventType: string; envelope: { payload: Record<string, unknown> } } };
    const calls = prisma.tx.outboxEvent.create.mock.calls as unknown as OutboxArg[][];
    const fanoutCall = calls.find((c) => c[0]?.data.eventType === 'panic.fanout_requested');
    expect(fanoutCall).toBeDefined();
    const payload = fanoutCall![0]!.data.envelope.payload;
    // Contrato: IDs + geo + deep-link. NADA de teléfono/nombre.
    expect(payload.contactIds).toEqual(['c1', 'c2']);
    expect(typeof payload.shareLink).toBe('string');
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/phone/i);
    expect(serialized).not.toMatch(/\+51/);
    expect(serialized).not.toMatch(/name/i);
  });

  it('redelivery (enlace ya existe) → NO re-emite el evento (emitted=false), sin duplicar fan-out', async () => {
    const prisma = makePrisma({ link: makeLink({ dedupKey: 'panic:pn-1:link' } as never) });
    const svc = new ShareService(prisma as never, config);

    const res = await svc.createPanicFanout('trip-1', panic, ttl);

    expect(res.emitted).toBe(false);
    expect(prisma.write.$transaction).not.toHaveBeenCalled();
    expect(prisma.tx.outboxEvent.create).not.toHaveBeenCalled();
  });
});

describe('ShareService.revoke · pertenencia falla-cerrado', () => {
  it('sin snapshot del viaje → deniega con UnprocessableEntityError', async () => {
    const prisma = makePrisma({ snapshot: null, link: makeLink() });
    const svc = new ShareService(prisma as never, config);

    await expect(svc.revoke('u1', 'share-1')).rejects.toBeInstanceOf(UnprocessableEntityError);
    expect(prisma.write.shareLink.update).not.toHaveBeenCalled();
  });

  it('passengerId distinto del solicitante → ForbiddenError (no revoca enlace ajeno)', async () => {
    const prisma = makePrisma({
      snapshot: { tripId: 'trip-1', passengerId: 'owner-1' },
      link: makeLink(),
    });
    const svc = new ShareService(prisma as never, config);

    await expect(svc.revoke('attacker', 'share-1')).rejects.toBeInstanceOf(ForbiddenError);
    expect(prisma.write.shareLink.update).not.toHaveBeenCalled();
  });

  it('dueño legítimo → revoca el enlace', async () => {
    const prisma = makePrisma({
      snapshot: { tripId: 'trip-1', passengerId: 'owner-1' },
      link: makeLink(),
    });
    const svc = new ShareService(prisma as never, config);

    const res = await svc.revoke('owner-1', 'share-1');

    expect(res.revokedAt).toBeTruthy();
    expect(prisma.write.shareLink.update).toHaveBeenCalledOnce();
  });
});

describe('ShareService.revokeAllForTrip · auto-revoke al terminar (kill-switch automático)', () => {
  it('revoca SOLO los enlaces vivos del viaje (filtra revokedAt:null) — sin userId', async () => {
    const prisma = makePrisma();
    (prisma.write.shareLink.updateMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 2 });
    const svc = new ShareService(prisma as never, config);

    const res = await svc.revokeAllForTrip('trip-1');

    expect(res.revoked).toBe(2);
    expect(prisma.write.shareLink.updateMany).toHaveBeenCalledOnce();
    const [args] = (prisma.write.shareLink.updateMany as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(args.where).toMatchObject({ tripId: 'trip-1', revokedAt: null });
    expect(args.data.revokedAt).toBeInstanceOf(Date);
  });

  it('idempotente: viaje sin enlaces vivos → revoked=0 (no-op, no rompe)', async () => {
    const prisma = makePrisma();
    const svc = new ShareService(prisma as never, config);

    await expect(svc.revokeAllForTrip('trip-1')).resolves.toEqual({ revoked: 0 });
  });
});
