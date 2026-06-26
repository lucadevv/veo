/**
 * E2E con Postgres REAL (testcontainers) del recorrido por STREAMING de `verifyRange` (anti-OOM).
 *
 * Fija un LOTE CHICO (BATCH=3) para FORZAR múltiples lotes con cadenas pequeñas y ejercitar:
 *  - verificación de la cadena COMPLETA atravesando varios lotes (memoria acotada a `BATCH` filas),
 *  - detección de tampering en el MEDIO de un lote,
 *  - detección de tampering en el BORDE de lote (el caso que un streaming naïf dejaría pasar) — cazado por
 *    el HASH ARRASTRADO entre lotes,
 *  - sub-rango [fromSeq, toSeq] con la semántica de inicio preservada,
 *  - EQUIVALENCIA: el resultado paginado es idéntico al de la verificación no-paginada (getRange + verifyChain).
 *
 * Reset entre escenarios: TRUNCATE ... RESTART IDENTITY (con los triggers append-only deshabilitados) → cada
 * test arranca con la cadena vacía y seq=1, sin levantar un contenedor por escenario.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  createTestDatabase,
  runPrismaMigrateDeploy,
  type TestDatabase,
} from '@veo/database/testing';
import { PrismaClient } from '../generated/prisma';
import { type PrismaService } from '../infra/prisma.service';
import { AuditRepository } from './audit.repository';
import { AuditService } from './audit.service';
import {
  computeEntryHash,
  verifyChain,
  type ChainRow,
  type ChainVerificationResult,
} from './chain';

/** Lote CHICO a propósito: con cadenas de 9–12 filas garantiza 3–4 lotes (ejercita el seam de borde). */
const BATCH = 3;

let db: TestDatabase;
let client: PrismaClient;
let repo: AuditRepository;
let service: AuditService;

beforeAll(async () => {
  db = await createTestDatabase({
    schema: 'audit',
    applyMigrations: (url) => runPrismaMigrateDeploy(url, process.cwd()),
  });
  client = new PrismaClient({ datasourceUrl: db.databaseUrl });
  await client.$connect();
  const prismaService = { write: client, read: client } as unknown as PrismaService;
  repo = new AuditRepository(prismaService);
  service = new AuditService(repo, BATCH);
});

afterAll(async () => {
  await client?.$disconnect();
  await db?.teardown();
});

beforeEach(async () => {
  // Reset duro: los triggers append-only bloquean DELETE; los deshabilitamos para TRUNCATE + reiniciar seq.
  await client.$executeRawUnsafe(`ALTER TABLE "audit"."audit_log" DISABLE TRIGGER USER`);
  await client.$executeRawUnsafe(`TRUNCATE "audit"."audit_log" RESTART IDENTITY`);
  await client.$executeRawUnsafe(`ALTER TABLE "audit"."audit_log" ENABLE TRIGGER USER`);
});

/** Inserta una cadena íntegra de N entradas a través del append real (hash chain + seq autoincrement). */
async function insertChain(n: number): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await service.recordSync({
      actorId: `actor-${i}`,
      action: 'trip.completed',
      resourceType: 'trip',
      resourceId: `trip-${i}`,
      payload: { i, fareCents: 1500 + i },
      ip: '10.0.0.1',
      userAgent: 'e2e-stream',
    });
  }
}

async function withTriggersDisabled(fn: () => Promise<void>): Promise<void> {
  await client.$executeRawUnsafe(`ALTER TABLE "audit"."audit_log" DISABLE TRIGGER USER`);
  try {
    await fn();
  } finally {
    await client.$executeRawUnsafe(`ALTER TABLE "audit"."audit_log" ENABLE TRIGGER USER`);
  }
}

/** Verificación NO-paginada de referencia (carga todo el rango): el oráculo de equivalencia. */
async function verifyNonPaginated(from?: bigint, to?: bigint): Promise<ChainVerificationResult> {
  const rows = await repo.getRange(from, to);
  const expectGenesis = from === undefined || from <= 1n;
  return verifyChain(rows, { expectGenesis });
}

/** Campos comparables (sin el eco de rango fromSeq/toSeq) para el assert de equivalencia. */
function core(r: ChainVerificationResult): ChainVerificationResult {
  return { valid: r.valid, checked: r.checked, brokenAtSeq: r.brokenAtSeq, reason: r.reason };
}

describe('verifyRange por streaming (Postgres real, lote chico)', () => {
  it('recorre TODA la cadena OK atravesando múltiples lotes, con memoria acotada al lote', async () => {
    await insertChain(10);

    const batchSpy = vi.spyOn(repo, 'getChainBatch');
    const rangeSpy = vi.spyOn(repo, 'getRange');

    const result = await service.verifyRange({});
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(10);
    expect(result.fromSeq).toBe('1');
    expect(result.toSeq).toBe('10');

    // Multi-lote: 10 filas / lote 3 ⇒ varios lotes (NO una sola carga). Y NUNCA usa el getRange sin cota.
    expect(batchSpy.mock.calls.length).toBeGreaterThan(1);
    expect(rangeSpy).not.toHaveBeenCalled();
    // Memoria acotada: ningún lote materializado supera BATCH filas.
    for (const call of batchSpy.mock.results) {
      expect(call.type).toBe('return');
      const rows = (await call.value) as ChainRow[];
      expect(rows.length).toBeLessThanOrEqual(BATCH);
    }
    batchSpy.mockRestore();
    rangeSpy.mockRestore();
  });

  it('detecta tampering en el MEDIO de un lote (idéntico al no-paginado)', async () => {
    await insertChain(10);
    // seq=5 cae en el medio del 2º lote [4,5,6]. Alteramos el payload SIN refijar el hash → CONTENT_TAMPERED.
    await withTriggersDisabled(async () => {
      await client.$executeRawUnsafe(
        `UPDATE "audit"."audit_log" SET payload = '{"tampered":true}'::jsonb WHERE seq = 5`,
      );
    });

    const streamed = await service.verifyRange({});
    const whole = await verifyNonPaginated();
    expect(streamed.valid).toBe(false);
    expect(streamed.reason).toBe('CONTENT_TAMPERED');
    expect(streamed.brokenAtSeq).toBe('5');
    expect(core(streamed)).toEqual(core(whole)); // equivalencia exacta
  });

  it('caza tampering en el BORDE de lote (última fila del lote, hash REFIJADO) vía hash arrastrado', async () => {
    await insertChain(9); // lotes [1,2,3] [4,5,6] [7,8,9]
    const border = (await repo.getRange(3n, 3n))[0]!; // seq=3, última del primer lote.

    // El atacante altera el contenido del borde y RECALCULA su hash para pasar la validación INTERNA del
    // lote 1. Pero el hash arrastrado (nuevo) ya no casa con el prevHash (original) de la fila 4.
    const alteredContent = { ...border, payload: { hacked: true } };
    const refixedHash = computeEntryHash(border.prevHash, alteredContent);
    await withTriggersDisabled(async () => {
      await client.$executeRawUnsafe(
        `UPDATE "audit"."audit_log" SET payload = '{"hacked":true}'::jsonb, hash = '${refixedHash}' WHERE seq = 3`,
      );
    });

    const streamed = await service.verifyRange({});
    expect(streamed.valid).toBe(false);
    expect(streamed.reason).toBe('BROKEN_LINK');
    expect(streamed.brokenAtSeq).toBe('4'); // la rotura aflora en la primera fila del lote siguiente.
    expect(core(streamed)).toEqual(core(await verifyNonPaginated())); // idéntico al no-paginado.

    // Prueba de que un streaming NAÏF (cada lote en aislamiento, sin hash arrastrado) lo dejaría pasar:
    // el primer lote, con su hash refijado, valida solo; el seam roto solo se ve cruzando lotes.
    const batch1 = await repo.getRange(1n, 3n);
    expect(verifyChain(batch1, { expectGenesis: true }).valid).toBe(true);
    const batch2 = await repo.getRange(4n, 6n);
    expect(verifyChain(batch2, { expectGenesis: false }).valid).toBe(true);
  });

  it('verifica un sub-rango [fromSeq, toSeq] preservando la semántica de inicio (no exige génesis)', async () => {
    await insertChain(9);
    const result = await service.verifyRange({ fromSeq: 4n, toSeq: 6n });
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(3);
    expect(result.fromSeq).toBe('4');
    expect(result.toSeq).toBe('6');
    expect(core(result)).toEqual(core(await verifyNonPaginated(4n, 6n)));
  });

  it('equivalencia: para una cadena íntegra multi-lote, el paginado == el no-paginado', async () => {
    await insertChain(12);
    const streamed = await service.verifyRange({});
    const whole = await verifyNonPaginated();
    expect(streamed.valid).toBe(true);
    expect(streamed.checked).toBe(12);
    expect(core(streamed)).toEqual(core(whole));
    expect([streamed.fromSeq, streamed.toSeq]).toEqual(['1', '12']);
  });
});
