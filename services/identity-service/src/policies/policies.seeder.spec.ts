import { describe, it, expect, vi } from 'vitest';
import { POLICY_KEYS, POLICY_CATALOG } from '@veo/policy';
import { PoliciesSeeder } from './policies.seeder';
import { PoliciesRepository } from './policies.repository';

/** Doble de repo que captura los rows del seed y devuelve un count controlado. */
function makeRepo(count: number = POLICY_KEYS.length) {
  const captured: { rows?: Array<Record<string, unknown>> } = {};
  const repo = {
    seedMissing: vi.fn(async (rows: Array<Record<string, unknown>>) => {
      captured.rows = rows;
      return { count };
    }),
  };
  return { repo, captured };
}

describe('PoliciesSeeder · siembra idempotente del catálogo PBAC (ADR-024 §5)', () => {
  it('mapea las 16 políticas del catálogo con su estado de default y updatedBy=system, version 1', async () => {
    const { repo, captured } = makeRepo();
    const seeder = new PoliciesSeeder(repo as unknown as PoliciesRepository);

    const inserted = await seeder.seed();

    expect(repo.seedMissing).toHaveBeenCalledTimes(1);
    expect(captured.rows).toHaveLength(POLICY_KEYS.length); // 16
    expect(inserted).toBe(POLICY_KEYS.length);

    // Cada row refleja EXACTO el default del catálogo (fuente única · sin deriva).
    for (const row of captured.rows!) {
      const def = POLICY_CATALOG[row.key as keyof typeof POLICY_CATALOG];
      expect(def).toBeDefined();
      expect(row).toEqual({
        key: def.key,
        family: def.family,
        enabled: def.defaultEnabled,
        params: def.defaults,
        mandatory: def.mandatory,
        version: 1,
        updatedBy: 'system',
      });
    }
  });

  it('es un no-op silencioso cuando el catálogo ya está completo (count 0)', async () => {
    const { repo } = makeRepo(0);
    const seeder = new PoliciesSeeder(repo as unknown as PoliciesRepository);
    await expect(seeder.seed()).resolves.toBe(0);
    expect(repo.seedMissing).toHaveBeenCalledTimes(1);
  });

  it('onModuleInit dispara la siembra', async () => {
    const { repo } = makeRepo();
    const seeder = new PoliciesSeeder(repo as unknown as PoliciesRepository);
    await seeder.onModuleInit();
    expect(repo.seedMissing).toHaveBeenCalledTimes(1);
  });
});

describe('PoliciesRepository.seedMissing · idempotencia por skipDuplicates', () => {
  it('usa createMany(skipDuplicates:true) y NUNCA update/delete (no pisa cambios del admin)', async () => {
    const captured: { args?: { data: unknown; skipDuplicates?: boolean } } = {};
    const createMany = vi.fn(async (args: { data: unknown; skipDuplicates?: boolean }) => {
      captured.args = args;
      return { count: 0 };
    });
    const forbidden = vi.fn(() => {
      throw new Error('el seed NO debe pisar: prohibido update/delete');
    });
    const prisma = {
      write: { policy: { createMany, update: forbidden, delete: forbidden, upsert: forbidden } },
      read: { policy: { findMany: forbidden, findUnique: forbidden } },
    };
    const repo = new PoliciesRepository(prisma as never);

    await repo.seedMissing([{ key: 'auth.stepup' } as never]);
    // Re-ejecutar es seguro: el mismo createMany con skipDuplicates absorbe el doble seed.
    await repo.seedMissing([{ key: 'auth.stepup' } as never]);

    expect(createMany).toHaveBeenCalledTimes(2);
    expect(captured.args?.skipDuplicates).toBe(true);
    expect(prisma.write.policy.update).not.toHaveBeenCalled();
    expect(prisma.write.policy.delete).not.toHaveBeenCalled();
    expect(prisma.write.policy.upsert).not.toHaveBeenCalled();
  });
});
