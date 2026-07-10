/**
 * Tests unitarios de PanicService que NO requieren base de datos: validan las guardas previas
 * al acceso a la DB (firma HMAC BR-S04 y formato de la dedupKey). El comportamiento real de
 * idempotencia/dedup contra Postgres se prueba en test/panic.e2e.spec.ts (testcontainers, DB real).
 *
 * La regla "prohibido mockear la DB" se respeta: aquí el cliente Prisma LANZA si se accede, de modo
 * que el test demuestra que estas guardas rechazan ANTES de tocar la base de datos.
 */
import { describe, it, expect } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedError, ValidationError, signHmac, uuidv7 } from '@veo/utils';
import { PanicService } from './panic.service';
import { PrismaPanicRepository } from './panic.repository';
import { PanicMetrics } from '../metrics/panic.metrics';
import { buildPanicSignatureMessage } from './panic.hmac';
import type { S3EvidenceStore } from '../ports/s3-evidence/s3-evidence.port';
import type { Env } from '../config/env.schema';

const SECRET = 'unit-test-panic-secret';

const config = new ConfigService<Env, true>({ EVIDENCE_KEYS_PER_PANIC: 1 } as Partial<Env>);

const evidence: S3EvidenceStore = {
  reserveKeys: (panicId, count) =>
    Array.from({ length: count }, (_, i) => `panic/${panicId}/evidence/${i}.bin`),
  ensureBucket: async () => undefined,
  protect: async (keys) => keys,
};

/** Cliente Prisma que lanza si se accede: prueba que NO se toca la DB en estos caminos. */
const dbForbidden = {
  get write(): never {
    throw new Error('La DB no debe accederse en este test');
  },
  get read(): never {
    throw new Error('La DB no debe accederse en este test');
  },
};

function makeService(): PanicService {
  // El repo envuelve el prisma prohibido: si el service intentara tocar la DB (via el repo), lanza.
  const repo = new PrismaPanicRepository(dbForbidden as never);
  return new PanicService(repo, new PanicMetrics(), evidence, SECRET, config);
}

function validInput(
  overrides: Partial<{ tripId: string; dedupKey: string; lat: number; lon: number }> = {},
) {
  const tripId = overrides.tripId ?? uuidv7();
  const dedupKey = overrides.dedupKey ?? uuidv7();
  const lat = overrides.lat ?? -12.0464;
  const lon = overrides.lon ?? -77.0428;
  const signature = signHmac(buildPanicSignatureMessage({ tripId, dedupKey, lat, lon }), SECRET);
  return { tripId, passengerId: uuidv7(), dedupKey, lat, lon, signature };
}

describe('PanicService.trigger · guardas previas a la DB (BR-S04)', () => {
  it('rechaza una firma HMAC inválida sin tocar la base de datos', async () => {
    const svc = makeService();
    const input = validInput();
    input.signature = signHmac('mensaje-distinto', SECRET); // firma de otro payload
    await expect(svc.trigger(input)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rechaza una firma con secreto incorrecto sin tocar la base de datos', async () => {
    const svc = makeService();
    const input = validInput();
    input.signature = signHmac(buildPanicSignatureMessage(input), 'secreto-equivocado');
    await expect(svc.trigger(input)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rechaza una dedupKey que no es UUIDv7 sin tocar la base de datos', async () => {
    const svc = makeService();
    // dedupKey UUIDv4 (no v7) → ValidationError antes de cualquier acceso a DB.
    const dedupKey = '550e8400-e29b-41d4-a716-446655440000';
    const input = validInput({ dedupKey });
    await expect(svc.trigger(input)).rejects.toBeInstanceOf(ValidationError);
  });
});
