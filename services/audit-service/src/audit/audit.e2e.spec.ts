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
import { isUuidV7, uuidv7 } from '@veo/utils';
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

describe('idempotencia del registro SÍNCRONO por eventId (espejo del carril Kafka)', () => {
  it('recordSync 2× con el MISMO eventId → UNA sola fila (el 2º es no-op idempotente)', async () => {
    const before = await repo.count();
    const eventId = uuidv7();
    const first = await service.recordSync({
      actorId: 'op-1',
      action: 'operator.create',
      resourceType: 'operator',
      resourceId: 'op-new-1',
      payload: { email: 'x@y.z' },
      ip: '10.0.0.9',
      userAgent: 'grpc',
      eventId,
    });
    // Retry de TRANSPORTE: mismo record() → mismo eventId.
    const second = await service.recordSync({
      actorId: 'op-1',
      action: 'operator.create',
      resourceType: 'operator',
      resourceId: 'op-new-1',
      payload: { email: 'x@y.z' },
      ip: '10.0.0.9',
      userAgent: 'grpc',
      eventId,
    });

    // ASSERT CLAVE: el WORM no creció en la 2ª llamada (el seq NO avanzó) y devuelve la fila EXISTENTE.
    expect(await repo.count()).toBe(before + 1);
    expect(second.eventId).toBe(first.eventId);
    expect(second.seq).toBe(first.seq);
    expect(second.hash).toBe(first.hash);
    expect(second.id).toBe(first.id);
  });

  it('recordSync con eventos DISTINTOS → 2 filas (no sobre-dedupea)', async () => {
    const before = await repo.count();
    const a = await service.recordSync({
      actorId: 'op-2',
      action: 'operator.create',
      resourceType: 'operator',
      resourceId: 'op-new-2',
      payload: {},
      ip: '',
      userAgent: 'grpc',
      eventId: uuidv7(),
    });
    const b = await service.recordSync({
      actorId: 'op-2',
      action: 'operator.create',
      resourceType: 'operator',
      resourceId: 'op-new-2',
      payload: {},
      ip: '',
      userAgent: 'grpc',
      eventId: uuidv7(),
    });
    expect(await repo.count()).toBe(before + 2);
    expect(a.eventId).not.toBe(b.eventId);
    expect(b.seq).toBe(a.seq + 1n);
  });

  it('backward-compat: sin eventId (caller legacy) → genera uno y NO crashea', async () => {
    const before = await repo.count();
    const entry = await service.recordSync({
      actorId: 'op-3',
      action: 'operator.create',
      resourceType: 'operator',
      resourceId: 'op-new-3',
      payload: {},
      ip: '',
      userAgent: 'grpc',
    });
    expect(await repo.count()).toBe(before + 1);
    // El servicio generó un eventId (UUIDv7) por su cuenta.
    expect(isUuidV7(entry.eventId)).toBe(true);
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

describe('filtros de lectura (categoría · búsqueda libre · rango de fecha · export)', () => {
  // Entradas AISLADAS con marcadores únicos para no depender del estado previo del WORM compartido.
  const D1 = new Date('2020-01-15T10:00:00.000Z');
  const D2 = new Date('2020-06-20T10:00:00.000Z');

  beforeAll(async () => {
    await service.recordSync({
      actorId: 'flt-a', action: 'zzcat.alpha', resourceType: 'zzflt', resourceId: 'r-early',
      payload: {}, ip: '', userAgent: 'e2e', occurredAt: D1, eventId: uuidv7(),
    });
    await service.recordSync({
      actorId: 'flt-b', action: 'zzcat.beta', resourceType: 'zzflt', resourceId: 'r-late',
      payload: {}, ip: '', userAgent: 'e2e', occurredAt: D2, eventId: uuidv7(),
    });
    await service.recordSync({
      actorId: 'flt-c', action: 'zzother.gamma', resourceType: 'zzflt', resourceId: 'r-other',
      payload: {}, ip: '', userAgent: 'e2e', occurredAt: D2, eventId: uuidv7(),
    });
  });

  it('categoría = prefijo de dominio de la acción (startsWith "${category}.")', async () => {
    const rows = await repo.query({ category: 'zzcat', limit: 50 });
    expect(rows.map((r) => r.action).sort()).toEqual(['zzcat.alpha', 'zzcat.beta']);
  });

  it('búsqueda libre (substring case-insensitive) sobre acción/recurso/actor', async () => {
    const byAction = await repo.query({ q: 'ZZCAT.AL', limit: 50 });
    expect(byAction.map((r) => r.action)).toEqual(['zzcat.alpha']);
    const byResource = await repo.query({ q: 'r-other', limit: 50 });
    expect(byResource.map((r) => r.resourceId)).toEqual(['r-other']);
  });

  it('rango de fecha inclusivo sobre occurredAt (from/to)', async () => {
    const fromMarch = await repo.query({ resourceType: 'zzflt', from: new Date('2020-03-01T00:00:00.000Z'), limit: 50 });
    expect(fromMarch.every((r) => r.occurredAt >= new Date('2020-03-01T00:00:00.000Z'))).toBe(true);
    expect(fromMarch.some((r) => r.resourceId === 'r-early')).toBe(false);
    expect(fromMarch.some((r) => r.resourceId === 'r-late')).toBe(true);

    const toMarch = await repo.query({ resourceType: 'zzflt', to: new Date('2020-03-01T00:00:00.000Z'), limit: 50 });
    expect(toMarch.map((r) => r.resourceId)).toEqual(['r-early']);
  });

  it('combina categoría + fecha (AND de cláusulas)', async () => {
    const rows = await repo.query({ category: 'zzcat', from: new Date('2020-03-01T00:00:00.000Z'), limit: 50 });
    expect(rows.map((r) => r.action)).toEqual(['zzcat.beta']);
  });

  it('export honra el MISMO filtro que el listado (set completo, sin cursor)', async () => {
    const rows = await service.exportRows({ category: 'zzcat' });
    expect(rows.map((r) => r.action).sort()).toEqual(['zzcat.alpha', 'zzcat.beta']);
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
