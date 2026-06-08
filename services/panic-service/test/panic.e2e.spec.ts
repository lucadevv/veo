/**
 * E2E con Postgres REAL (testcontainers). NO se mockea la base de datos (CLAUDE regla 3).
 * Prueba el dominio de idempotencia/dedup (BR-S04) y la publicación por outbox (BR-S05) contra
 * un Postgres efímero con las migraciones reales aplicadas.
 *
 * Casos adversariales:
 *  - Doble submit (secuencial y concurrente) con la misma dedupKey → 1 sola fila y 1 solo evento.
 *  - Firma HMAC inválida → rechazo y 0 filas.
 *  - Ack idempotente de estado (no se puede reconocer dos veces).
 *  - Medición de p99 del ack (<800ms).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { createTestDatabase, runPrismaMigrateDeploy, type TestDatabase } from '@veo/database/testing';
import { signHmac, uuidv7, UnauthorizedError } from '@veo/utils';
import { PrismaClient } from '../src/generated/prisma';
import { PanicService } from '../src/panic/panic.service';
import { PanicMetrics } from '../src/metrics/panic.metrics';
import { buildPanicSignatureMessage } from '../src/panic/panic.hmac';
import type { S3EvidenceStore } from '../src/ports/s3-evidence/s3-evidence.port';
import type { Env } from '../src/config/env.schema';

const SECRET = 'e2e-panic-hmac-secret';

const evidence: S3EvidenceStore = {
  reserveKeys: (panicId, count) =>
    Array.from({ length: count }, () => `panic/${panicId}/evidence/${uuidv7()}.bin`),
  ensureBucket: async () => undefined,
  protect: async (keys) => keys,
};

const config = new ConfigService<Env, true>({ EVIDENCE_KEYS_PER_PANIC: 1 } as Partial<Env>);

let db: TestDatabase;
let client: PrismaClient;
let svc: PanicService;

function makeSignedInput(overrides: Partial<{ tripId: string; dedupKey: string; lat: number; lon: number }> = {}) {
  const tripId = overrides.tripId ?? uuidv7();
  const dedupKey = overrides.dedupKey ?? uuidv7();
  const lat = overrides.lat ?? -12.0464;
  const lon = overrides.lon ?? -77.0428;
  const signature = signHmac(buildPanicSignatureMessage({ tripId, dedupKey, lat, lon }), SECRET);
  return { tripId, passengerId: uuidv7(), dedupKey, lat, lon, signature };
}

beforeAll(async () => {
  db = await createTestDatabase({
    schema: 'panic',
    applyMigrations: (url) => runPrismaMigrateDeploy(url, process.cwd()),
  });
  client = new PrismaClient({ datasourceUrl: db.databaseUrl });
  await client.$connect();
  const prismaLike = { write: client, read: client } as never;
  svc = new PanicService(prismaLike, new PanicMetrics(), evidence, SECRET, config);
});

afterAll(async () => {
  await client?.$disconnect();
  await db?.teardown();
});

describe('panic-service E2E · idempotencia BR-S04 (Postgres real)', () => {
  it('el primer submit crea la fila y publica panic.triggered por outbox', async () => {
    const input = makeSignedInput();
    const res = await svc.trigger(input);

    expect(res.deduplicated).toBe(false);
    expect(res.status).toBe('TRIGGERED');
    expect(res.evidenceS3Keys).toHaveLength(1);

    const rows = await client.panicEvent.findMany({ where: { dedupKey: input.dedupKey } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(res.panicId);
    expect(rows[0]?.passengerId).toBe(input.passengerId);

    const events = await client.outboxEvent.findMany({
      where: { aggregateId: res.panicId, eventType: 'panic.triggered' },
    });
    expect(events).toHaveLength(1);
  });

  it('doble submit SECUENCIAL con la misma dedupKey = 1 fila y 1 solo evento', async () => {
    const input = makeSignedInput();
    const first = await svc.trigger(input);
    const second = await svc.trigger(input);

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.panicId).toBe(first.panicId);

    const rows = await client.panicEvent.findMany({ where: { dedupKey: input.dedupKey } });
    expect(rows).toHaveLength(1);

    const events = await client.outboxEvent.findMany({
      where: { aggregateId: first.panicId, eventType: 'panic.triggered' },
    });
    expect(events).toHaveLength(1);
  });

  it('doble submit CONCURRENTE con la misma dedupKey = 1 fila y 1 solo evento', async () => {
    const input = makeSignedInput();
    const [a, b] = await Promise.all([svc.trigger(input), svc.trigger(input)]);

    expect(a.panicId).toBe(b.panicId);
    // exactamente uno creó y el otro fue no-op idempotente.
    expect([a.deduplicated, b.deduplicated].filter(Boolean)).toHaveLength(1);

    const rows = await client.panicEvent.findMany({ where: { dedupKey: input.dedupKey } });
    expect(rows).toHaveLength(1);

    const events = await client.outboxEvent.findMany({
      where: { aggregateId: a.panicId, eventType: 'panic.triggered' },
    });
    expect(events).toHaveLength(1);
  });

  it('rechaza firma HMAC inválida y NO crea fila', async () => {
    const input = makeSignedInput();
    const tampered = { ...input, signature: signHmac('payload-falso', SECRET) };
    await expect(svc.trigger(tampered)).rejects.toBeInstanceOf(UnauthorizedError);

    const rows = await client.panicEvent.findMany({ where: { dedupKey: input.dedupKey } });
    expect(rows).toHaveLength(0);
  });
});

describe('panic-service E2E · ack/resolve BR-S05 (Postgres real)', () => {
  it('ack reconoce la alerta y publica panic.acknowledged; no se puede reconocer dos veces', async () => {
    const operatorId = uuidv7();
    const created = await svc.trigger(makeSignedInput());

    const acked = await svc.acknowledge(created.panicId, operatorId);
    expect(acked.status).toBe('ACKNOWLEDGED');
    expect(acked.ackBy).toBe(operatorId);
    expect(acked.acknowledgedAt).toBeInstanceOf(Date);

    const events = await client.outboxEvent.findMany({
      where: { aggregateId: created.panicId, eventType: 'panic.acknowledged' },
    });
    expect(events).toHaveLength(1);

    await expect(svc.acknowledge(created.panicId, operatorId)).rejects.toThrow();
  });

  it('resolve cierra la alerta (FALSE_ALARM)', async () => {
    const created = await svc.trigger(makeSignedInput());
    const resolved = await svc.resolve(created.panicId, 'FALSE_ALARM');
    expect(resolved.status).toBe('FALSE_ALARM');
    expect(resolved.resolvedAt).toBeInstanceOf(Date);
  });

  it('anexa evidencia S3 sin duplicar keys', async () => {
    const created = await svc.trigger(makeSignedInput());
    const k1 = `panic/${created.panicId}/evidence/${uuidv7()}.bin`;
    const k2 = `panic/${created.panicId}/evidence/${uuidv7()}.bin`;
    await svc.appendEvidence(created.panicId, [k1], true);
    const after = await svc.appendEvidence(created.panicId, [k1, k2], true);
    // sin duplicados: la reserva inicial (1) + k1 + k2 = 3
    expect(new Set(after.evidenceS3Keys).size).toBe(after.evidenceS3Keys.length);
    expect(after.evidenceS3Keys).toContain(k1);
    expect(after.evidenceS3Keys).toContain(k2);
  });
});

describe('panic-service E2E · latencia del ack (SLO <800ms p99)', () => {
  it('mide p99 del ack del trigger bajo carga secuencial', async () => {
    const N = 100;
    // Warmup (conexiones/planes en caliente).
    for (let i = 0; i < 10; i += 1) await svc.trigger(makeSignedInput());

    const samples: number[] = [];
    for (let i = 0; i < N; i += 1) {
      const res = await svc.trigger(makeSignedInput());
      samples.push(res.ackMs);
    }
    samples.sort((a, b) => a - b);
    const p99 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.99))] ?? 0;
    const p50 = samples[Math.floor(samples.length * 0.5)] ?? 0;
    // eslint-disable-next-line no-console
    console.log(`[panic ack latency] p50=${p50.toFixed(2)}ms p99=${p99.toFixed(2)}ms (n=${N})`);
    expect(p99).toBeLessThan(800);
  });
});
