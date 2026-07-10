import { describe, it, expect, vi } from 'vitest';
import { ConsentsService } from './consents.service';
import { ConsentsRepository } from './consents.repository';

/**
 * Prisma doble: captura el `create` del consentimiento y prohíbe `update`/`delete` (append-only).
 * Refleja en la respuesta los datos enviados, añadiendo id/acceptedAt como haría la DB.
 */
function makePrisma(captured?: { create?: unknown }) {
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => {
    if (captured) captured.create = args;
    return {
      id: 'consent-1',
      userId: args.data.userId as string,
      dataProcessing: args.data.dataProcessing as boolean,
      inCabinCamera: args.data.inCabinCamera as boolean,
      location: args.data.location as boolean,
      marketing: args.data.marketing as boolean,
      policyVersion: args.data.policyVersion as string,
      acceptedAt: new Date('2026-05-31T12:00:00.000Z'),
      ip: (args.data.ip as string | null) ?? null,
    };
  });
  const forbidden = vi.fn(() => {
    throw new Error('append-only: prohibido mutar consentimientos');
  });
  return {
    write: { consent: { create, update: forbidden, delete: forbidden, upsert: forbidden } },
    read: { consent: { findUnique: forbidden } },
  };
}

const input = {
  dataProcessing: true,
  inCabinCamera: true,
  location: false,
  marketing: true,
  policyVersion: '2026-05-01',
  ip: '200.48.225.130',
};

describe('ConsentsService.record · registro append-only (Ley 29733)', () => {
  it('inserta un nuevo consentimiento (solo create) y devuelve la vista del row', async () => {
    const captured: { create?: unknown } = {};
    const svc = new ConsentsService(new ConsentsRepository(makePrisma(captured) as never));

    const out = await svc.record('user-1', input);

    expect(out).toEqual({
      id: 'consent-1',
      userId: 'user-1',
      dataProcessing: true,
      inCabinCamera: true,
      location: false,
      marketing: true,
      policyVersion: '2026-05-01',
      acceptedAt: '2026-05-31T12:00:00.000Z',
    });
    const create = captured.create as { data: Record<string, unknown> };
    expect(create.data).toEqual({
      userId: 'user-1',
      dataProcessing: true,
      inCabinCamera: true,
      location: false,
      marketing: true,
      policyVersion: '2026-05-01',
      ip: '200.48.225.130',
      // Sin dedupKey en el input → se inserta null (append-only puro, backward-compat).
      dedupKey: null,
    });
  });

  it('usa create (nunca update/delete): cada aceptación es un row inmutable', async () => {
    const prisma = makePrisma();
    const svc = new ConsentsService(new ConsentsRepository(prisma as never));

    await svc.record('user-1', input);
    await svc.record('user-1', { ...input, location: true });

    // Dos aceptaciones → dos inserciones independientes, sin tocar rows previos.
    expect(prisma.write.consent.create).toHaveBeenCalledTimes(2);
    expect(prisma.write.consent.update).not.toHaveBeenCalled();
    expect(prisma.write.consent.delete).not.toHaveBeenCalled();
    expect(prisma.write.consent.upsert).not.toHaveBeenCalled();
  });

  it('persiste ip null cuando el BFF no pudo determinar la IP', async () => {
    const captured: { create?: unknown } = {};
    const svc = new ConsentsService(new ConsentsRepository(makePrisma(captured) as never));

    await svc.record('user-1', { ...input, ip: null });

    const create = captured.create as { data: { ip: string | null } };
    expect(create.data.ip).toBeNull();
  });
});
