import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ForbiddenError, NotFoundError, ValidationError } from '@veo/utils';
import { AdminRole } from '@veo/shared-types';
import { AdminService } from './admin.service';
import { InvalidStatusTransition } from '../domain/state-machine';
import type { Env } from '../config/env.schema';

const config = new ConfigService<Env, true>({ TOTP_ENC_KEY: 'k'.repeat(32) });

/** Prisma doble: reject lee y escribe DENTRO de la tx (la réplica devuelve estado posiblemente viejo). */
function makeRejectPrisma(replicaAdmin: unknown, txAdmin: unknown = replicaAdmin) {
  const writes: Record<string, unknown>[] = [];
  return {
    writes,
    prisma: {
      read: { adminUser: { findUnique: async () => replicaAdmin } },
      write: {
        $transaction: async (fn: (t: unknown) => Promise<unknown>) =>
          fn({
            adminUser: {
              findUnique: async () => txAdmin,
              update: async ({ data }: { data: Record<string, unknown> }) => {
                writes.push(data);
                return { id: 'a1', ...data };
              },
            },
          }),
      },
    },
  };
}

function makeService(prisma: unknown): AdminService {
  return new AdminService(prisma as never, {} as never, {} as never, config);
}

describe('AdminService.reject · decisión validada por la máquina dentro de la tx', () => {
  it('rechaza un PENDING → REJECTED', async () => {
    const { prisma, writes } = makeRejectPrisma({ id: 'a1', status: 'PENDING' });
    await makeService(prisma).reject('a1');
    expect(writes).toEqual([{ status: 'REJECTED' }]);
  });

  it('reject TOCTOU: la réplica decía PENDING pero la tx ve un estado inválido → 409 con CERO writes', async () => {
    // El assert corre sobre lo que ve la TX, no la réplica: un from fuera del enum (fila legacy)
    // es fail-closed SIEMPRE. (→ REJECTED es válida desde todo estado del enum, y re-aplicar el
    // mismo estado es no-op idempotente por diseño; el 409 serializado aparece en este caso.)
    const { prisma, writes } = makeRejectPrisma(
      { id: 'a1', status: 'PENDING' },
      { id: 'a1', status: 'LEGACY_GARBAGE' },
    );
    await expect(makeService(prisma).reject('a1')).rejects.toBeInstanceOf(InvalidStatusTransition);
    expect(writes).toHaveLength(0);
  });

  it('reject concurrente que ya dejó REJECTED: re-aplicación idempotente (no-op válido por diseño)', async () => {
    const { prisma, writes } = makeRejectPrisma(
      { id: 'a1', status: 'PENDING' },
      { id: 'a1', status: 'REJECTED' },
    );
    await expect(makeService(prisma).reject('a1')).resolves.toBeUndefined();
    expect(writes).toEqual([{ status: 'REJECTED' }]);
  });

  it('reject: 404 si el operador no existe (la lectura vive dentro de la tx)', async () => {
    const { prisma, writes } = makeRejectPrisma({ id: 'a1', status: 'PENDING' }, null);
    await expect(makeService(prisma).reject('a1')).rejects.toBeInstanceOf(NotFoundError);
    expect(writes).toHaveLength(0);
  });
});

/**
 * Prisma doble para approve: read.findUnique (réplica) + write.update.
 * Los spies permiten afirmar que la escalada CORTA antes de tocar la DB.
 */
function makeApprovePrisma(replicaAdmin: unknown) {
  const findUnique = vi.fn(async () => replicaAdmin);
  const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'a1',
    ...data,
  }));
  return {
    findUnique,
    update,
    prisma: {
      read: { adminUser: { findUnique } },
      write: { adminUser: { update } },
    },
  };
}

describe('AdminService.approve · anti-escalada de privilegios (jerarquía estricta)', () => {
  it('ADMIN → [SUPERADMIN]: ForbiddenError 403 SIN tocar la DB', async () => {
    const { prisma, findUnique, update } = makeApprovePrisma({ id: 'a1', status: 'PENDING' });
    const err = await makeService(prisma)
      .approve([AdminRole.ADMIN], 'a1', [AdminRole.SUPERADMIN])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).httpStatus).toBe(403);
    expect(findUnique).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('ADMIN → [SUPPORT_L2]: OK, transiciona a ACTIVE con los roles', async () => {
    const { prisma, update } = makeApprovePrisma({ id: 'a1', status: 'PENDING' });
    const res = await makeService(prisma).approve([AdminRole.ADMIN], 'a1', [AdminRole.SUPPORT_L2]);
    expect(res.status).toBe('ACTIVE');
    expect(res.roles).toEqual([AdminRole.SUPPORT_L2]);
    expect(update).toHaveBeenCalledOnce();
  });

  it('SUPERADMIN → [SUPERADMIN]: OK (excepción explícita)', async () => {
    const { prisma } = makeApprovePrisma({ id: 'a1', status: 'PENDING' });
    const res = await makeService(prisma).approve([AdminRole.SUPERADMIN], 'a1', [
      AdminRole.SUPERADMIN,
    ]);
    expect(res.status).toBe('ACTIVE');
    expect(res.roles).toEqual([AdminRole.SUPERADMIN]);
  });

  it('rol fuera del enum → ValidationError ANTES del check de jerarquía y sin tocar DB', async () => {
    const { prisma, findUnique, update } = makeApprovePrisma({ id: 'a1', status: 'PENDING' });
    await expect(
      makeService(prisma).approve([AdminRole.SUPERADMIN], 'a1', ['NO_EXISTE']),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(findUnique).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
