/**
 * E2E con Postgres REAL (testcontainers, sin mocks). Verifica contra la DB:
 *  - append-only del hash chain (inserción de N entradas + verificación íntegra),
 *  - idempotencia por eventId,
 *  - triggers append-only (UPDATE/DELETE rechazados; s3_object_key write-once),
 *  - detección de tampering a nivel de storage (deshabilitando triggers y alterando una fila).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestDatabase,
  runPrismaMigrateDeploy,
  type TestDatabase,
} from '@veo/database/testing';
import { createEnvelope } from '@veo/events';
import { PrismaClient } from '../generated/prisma';
import { type PrismaService } from '../infra/prisma.service';
import { AuditRepository } from './audit.repository';
import { AuditService } from './audit.service';

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
  service = new AuditService(repo);
});

afterAll(async () => {
  await client?.$disconnect();
  await db?.teardown();
});

describe('append-only hash chain (Postgres real)', () => {
  it('inserta N entradas y verifica la cadena íntegra', async () => {
    const N = 25;
    for (let i = 0; i < N; i++) {
      await service.recordSync({
        actorId: `actor-${i}`,
        action: 'trip.completed',
        resourceType: 'trip',
        resourceId: `trip-${i}`,
        payload: { i, fareCents: 1500 + i },
        ip: '10.0.0.1',
        userAgent: 'e2e',
      });
    }
    expect(await repo.count()).toBe(N);

    const result = await service.verifyRange({});
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(N);
    expect(result.fromSeq).toBe('1');
    expect(result.toSeq).toBe(String(N));
  });

  it('encadena prevHash correctamente (primera = GENESIS)', async () => {
    const rows = await repo.getRange(1n, 3n);
    expect(rows[0]!.prevHash).toBeNull();
    expect(rows[1]!.prevHash).toBe(rows[0]!.hash);
    expect(rows[2]!.prevHash).toBe(rows[1]!.hash);
  });

  it('es idempotente por eventId (reprocesar un evento Kafka no duplica)', async () => {
    const before = await repo.count();
    const envelope = createEnvelope({
      eventType: 'panic.triggered',
      producer: 'panic-service',
      payload: {
        panicId: 'p1',
        tripId: 't1',
        passengerId: 'u1',
        geo: { lat: -12, lon: -77 },
        dedupKey: 'd1',
        triggeredAt: new Date().toISOString(),
      },
    });
    const first = await service.recordFromEvent(envelope, 'panic', {
      actorId: 'u1',
      resourceType: 'panic',
      resourceId: 'p1',
    });
    const second = await service.recordFromEvent(envelope, 'panic', {
      actorId: 'u1',
      resourceType: 'panic',
      resourceId: 'p1',
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await repo.count()).toBe(before + 1);
    // El registro idempotente devuelve la MISMA entrada (mismo hash).
    expect(second.entry.hash).toBe(first.entry.hash);
  });
});

describe('triggers append-only a nivel de DB', () => {
  it('rechaza UPDATE de columnas inmutables', async () => {
    await expect(
      client.$executeRawUnsafe(`UPDATE "audit"."audit_log" SET action = 'hacked' WHERE seq = 1`),
    ).rejects.toThrow(/append-only/);
  });

  it('rechaza DELETE', async () => {
    await expect(
      client.$executeRawUnsafe(`DELETE FROM "audit"."audit_log" WHERE seq = 1`),
    ).rejects.toThrow(/append-only/);
  });

  it('permite estampar s3_object_key una sola vez (write-once)', async () => {
    const row = (await repo.getRange(1n, 1n))[0]!;
    const entry = await repo.findOneByEventId(row.eventId);
    await repo.stampS3Key(entry!.id, 'audit/0000-key.json');
    const after = await repo.findOneByEventId(row.eventId);
    expect(after!.s3ObjectKey).toBe('audit/0000-key.json');
    // Un segundo intento directo (con valor previo) es rechazado por el trigger.
    await expect(
      client.$executeRawUnsafe(
        `UPDATE "audit"."audit_log" SET s3_object_key = 'otro' WHERE id = '${entry!.id}'`,
      ),
    ).rejects.toThrow(/write-once|append-only/);
  });
});

describe('detección de tampering a nivel de storage', () => {
  it('detecta una fila alterada saltándose los triggers (breach de superusuario)', async () => {
    // Verificación previa: la cadena está íntegra.
    expect((await service.verifyRange({})).valid).toBe(true);

    // Simula un atacante con privilegios que deshabilita los triggers y altera una fila
    // directamente en el storage (escenario que el hash chain debe detectar igualmente).
    await client.$executeRawUnsafe(`ALTER TABLE "audit"."audit_log" DISABLE TRIGGER USER`);
    await client.$executeRawUnsafe(
      `UPDATE "audit"."audit_log" SET payload = '{"tampered":true}'::jsonb WHERE seq = 5`,
    );
    await client.$executeRawUnsafe(`ALTER TABLE "audit"."audit_log" ENABLE TRIGGER USER`);

    const result = await service.verifyRange({});
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('CONTENT_TAMPERED');
    expect(result.brokenAtSeq).toBe('5');
  });
});
