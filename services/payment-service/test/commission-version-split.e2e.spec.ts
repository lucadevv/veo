/**
 * E2E con Postgres REAL (testcontainers) — el DESACOPLE de la CAS de comisión es un invariante de DINERO + UX: la
 * comisión ON-DEMAND (`version`) y el service fee CARPOOLING (`carpoolingFeeVersion`) se editan desde DOS paneles
 * admin distintos, cada uno con SU version. Antes compartían UNA `version`: editar uno 409eaba al otro (la plata
 * siempre estuvo a salvo por el CAS, pero era un footgun de UX). Sin mock de DB (CLAUDE: la comisión es money — el
 * invariante clave se prueba contra Postgres real, con la migración y el mapeo Prisma REALES, no un fake).
 *
 * Verifica, sobre la fila GLOBAL sembrada por la migración (on-demand 2000 bps, version 1; carpooling 0,
 * carpoolingFeeVersion backfilleada = 1):
 *   (a) replaceOnDemandRate NO mueve `carpoolingFeeVersion` (y viceversa);
 *   (b) tras editar carpooling (bump carpoolingFeeVersion), un replaceOnDemandRate con la `version` de on-demand
 *       VIGENTE SÍ funciona — NO hay 409 cruzado;
 *   (c) los valores de plata (onDemandRateBps / carpoolingFeeBps) quedan correctos y no se pisan entre carriles.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  runPrismaMigrateDeploy,
  type TestDatabase,
} from '@veo/database/testing';
import { ConflictError } from '@veo/utils';
import type { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../src/generated/prisma';
import { PrismaCommissionRepository } from '../src/commission/commission.repository';
import { CommissionService } from '../src/commission/commission.service';
import type { PrismaService } from '../src/infra/prisma.service';
import type { Env } from '../src/config/env.schema';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));
const GLOBAL = 'GLOBAL';

let db: TestDatabase;
let prisma: PrismaClient;
let service: CommissionService;

/** Config mínima: CommissionService solo lee COMMISSION_RATE (float 0..1) del constructor. */
function makeConfig(): ConfigService<Env, true> {
  return { getOrThrow: () => 0.2 } as unknown as ConfigService<Env, true>;
}

beforeAll(async () => {
  db = await createTestDatabase({
    schema: 'payment',
    applyMigrations: (url) => runPrismaMigrateDeploy(url, serviceDir),
  });
  prisma = new PrismaClient({ datasourceUrl: db.databaseUrl });
  await prisma.$connect();
  const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
  const repo = new PrismaCommissionRepository(prismaService);
  // cacheTtlMs 0 → cada getConfig lee la DB (sin cache stale entre pasos del test).
  service = new CommissionService(repo, makeConfig(), 0);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.teardown();
});

describe('commission · desacople de CAS on-demand ↔ carpooling (Postgres real)', () => {
  it('la migración siembra GLOBAL con carpoolingFeeVersion backfilleada = version', async () => {
    const seeded = await service.getConfig();
    expect(seeded.onDemandRateBps).toBe(2000);
    expect(seeded.carpoolingFeeBps).toBe(0);
    expect(seeded.version).toBe(1);
    expect(seeded.carpoolingFeeVersion).toBe(1); // backfill = version (continuidad del cliente)
  });

  it('(a) replaceOnDemandRate bumpea SOLO `version`, deja `carpoolingFeeVersion` intacta', async () => {
    const out = await service.replaceOnDemandRate(1500, 1);
    expect(out.onDemandRateBps).toBe(1500);
    expect(out.version).toBe(2);
    expect(out.carpoolingFeeBps).toBe(0); // carpooling INTACTO
    expect(out.carpoolingFeeVersion).toBe(1); // su version NO se movió
  });

  it('(a) replaceCarpoolingFee bumpea SOLO `carpoolingFeeVersion`, deja `version` intacta', async () => {
    const out = await service.replaceCarpoolingFee(1200, 1);
    expect(out.carpoolingFeeBps).toBe(1200);
    expect(out.carpoolingFeeVersion).toBe(2);
    expect(out.onDemandRateBps).toBe(1500); // on-demand INTACTO
    expect(out.version).toBe(2); // su version NO se movió (la editó el paso anterior, no este)
  });

  it('(b) tras editar carpooling, replaceOnDemandRate con la `version` de on-demand VIGENTE (2) NO 409ea', async () => {
    // Este es EL bug que se arregla: antes carpooling había bumpeado la version COMPARTIDA a 3, así que el panel
    // on-demand (que cargó 2) 409eaba. Con la CAS desacoplada, la version de on-demand sigue en 2 → pega limpio.
    const out = await service.replaceOnDemandRate(1800, 2);
    expect(out.version).toBe(3);
    expect(out.onDemandRateBps).toBe(1800);
    expect(out.carpoolingFeeBps).toBe(1200); // carpooling preservado
    expect(out.carpoolingFeeVersion).toBe(2);
  });

  it('el CAS de cada carril SIGUE protegiendo su propio lost update (version stale → 409)', async () => {
    await expect(service.replaceOnDemandRate(9999, 2)).rejects.toThrow(ConflictError); // version ya es 3
    await expect(service.replaceCarpoolingFee(9999, 1)).rejects.toThrow(ConflictError); // carpoolingFeeVersion ya es 2
  });

  it('(c) la fila persistida en Postgres tiene los valores de plata correctos, sin pisarse entre carriles', async () => {
    const persisted = await prisma.commissionConfig.findUnique({ where: { id: GLOBAL } });
    expect(persisted).not.toBeNull();
    expect(persisted?.onDemandRateBps).toBe(1800);
    expect(persisted?.carpoolingFeeBps).toBe(1200);
    expect(persisted?.version).toBe(3);
    expect(persisted?.carpoolingFeeVersion).toBe(2);
  });
});
