import { describe, it, expect } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { DriversService } from './drivers.service';
import { SuspensionCause } from '@veo/shared-types';
import type { Env } from '../config/env.schema';

/**
 * AUTO-suspensión por EXCESO DE CANCELACIONES (hold TEMPORAL EXCESSIVE_CANCELLATIONS con `expiresAt`) + el
 * SWEEPER que lo auto-levanta al vencer. Verifica:
 *  - suspendByCancellations crea un hold con expiresAt = now + cooldown
 *  - una RE-ENTREGA (mismo evento) NO extiende el cooldown (update no-op en conflicto)
 *  - sweepExpiredHolds quita los vencidos, recomputa y emite driver.reactivated si quedó con 0 holds
 *  - el sweeper NO toca holds PERMANENTES (expiresAt null)
 *  - el sweeper NO emite reactivated si el conductor SIGUE con otra causa (p.ej. DISCIPLINARY)
 *  - el override del operador (reactivateForCompliance) libera el hold EXCESSIVE_CANCELLATIONS antes del vencimiento
 *
 * FAKE de `DriverSuspensionHold` con `expiresAt` + el `Driver` derivado, semántica REAL del modelo de holds
 * (natural key, upsert idempotente, deleteMany por where con soporte de `expiresAt: { not, lt }`, derivación de
 * suspendedAt). Incluye `read.driverSuspensionHold.findMany` que usa el sweeper.
 */
interface Hold {
  driverId: string;
  cause: string;
  causeRef: string;
  reason: string;
  createdAt: Date;
  expiresAt: Date | null;
}

const futureLicense = new Date(Date.now() + 1_000_000_000);
const config = new ConfigService<Env, true>({
  BIOMETRIC_MIN_SCORE: 90,
  DRIVER_DNI_ENC_KEY: 'k'.repeat(32),
  DNI_HASH_SALT: 'test-dni-salt',
  EXCESSIVE_CANCELLATION_COOLDOWN_HOURS: 24,
});

function matchesExpiresAt(h: Hold, cond: { not?: null; lt?: Date } | undefined, now: Date): boolean {
  if (cond === undefined) return true;
  // `{ not: null, lt: now }` → hold temporal vencido.
  if ('not' in cond && cond.not === null && h.expiresAt === null) return false;
  if (cond.lt !== undefined) {
    if (h.expiresAt === null) return false;
    if (!(h.expiresAt < (cond.lt ?? now))) return false;
  }
  return true;
}

function holdMatches(h: Hold, where: Record<string, unknown>, now: Date): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'driverId') {
      if (h.driverId !== v) return false;
    } else if (k === 'cause') {
      if (v && typeof v === 'object' && 'not' in (v as Record<string, unknown>)) {
        if (h.cause === (v as { not: string }).not) return false;
      } else if (h.cause !== v) return false;
    } else if (k === 'causeRef') {
      if (h.causeRef !== v) return false;
    } else if (k === 'expiresAt') {
      if (!matchesExpiresAt(h, v as { not?: null; lt?: Date }, now)) return false;
    }
  }
  return true;
}

function makePrisma(opts: { initialHolds?: Hold[]; driverExists?: boolean; driverId?: string } = {}) {
  const driverId = opts.driverId ?? 'd1';
  const driverExists = opts.driverExists ?? true;
  const holds: Hold[] = [...(opts.initialHolds ?? [])];
  const outbox: { eventType: string; envelope: { payload: unknown } }[] = [];

  const deriveSuspendedAt = (): Date | null => {
    const mine = holds.filter((h) => h.driverId === driverId);
    if (mine.length === 0) return null;
    return mine.reduce((min, h) => (h.createdAt < min ? h.createdAt : min), mine[0]!.createdAt);
  };
  const driverRow = () =>
    driverExists
      ? { id: driverId, userId: 'u1', licenseExpiresAt: futureLicense, suspendedAt: deriveSuspendedAt() }
      : null;

  const holdClient = {
    findUnique: async ({
      where,
    }: {
      where: { driverId_cause_causeRef: { driverId: string; cause: string; causeRef: string } };
    }) => {
      const k = where.driverId_cause_causeRef;
      return (
        holds.find((h) => h.driverId === k.driverId && h.cause === k.cause && h.causeRef === k.causeRef) ??
        null
      );
    },
    findFirst: async ({ where }: { where: { driverId: string } }) => {
      const mine = holds
        .filter((h) => h.driverId === where.driverId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return mine[0] ?? null;
    },
    findMany: async ({ where }: { where: Record<string, unknown> }) => {
      const now = new Date();
      return holds.filter((h) => holdMatches(h, where, now)).map((h) => ({ driverId: h.driverId }));
    },
    count: async ({ where }: { where: Record<string, unknown> }) =>
      holds.filter((h) => holdMatches(h, where, new Date())).length,
    upsert: async ({
      where,
      create,
    }: {
      where: { driverId_cause_causeRef: { driverId: string; cause: string; causeRef: string } };
      create: Hold;
    }) => {
      const k = where.driverId_cause_causeRef;
      const found = holds.find(
        (h) => h.driverId === k.driverId && h.cause === k.cause && h.causeRef === k.causeRef,
      );
      // update vacío → no-op si existe (preserva createdAt Y expiresAt: no extiende el cooldown).
      if (!found) {
        holds.push({ ...create, createdAt: create.createdAt ?? new Date(), expiresAt: create.expiresAt ?? null });
      }
      return {};
    },
    deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
      const now = new Date();
      const before = holds.length;
      for (let i = holds.length - 1; i >= 0; i--) {
        if (holdMatches(holds[i]!, where, now)) holds.splice(i, 1);
      }
      return { count: before - holds.length };
    },
  };

  const tx = {
    driver: {
      findUnique: async ({ where }: { where: { id?: string } }) => {
        if (where.id !== undefined && where.id !== driverId) return null;
        return driverRow();
      },
      update: async () => {
        if (!driverExists) {
          const err = new Error('record not found');
          (err as unknown as { code: string }).code = 'P2025';
          throw err;
        }
        return {};
      },
    },
    driverSuspensionHold: holdClient,
    outboxEvent: {
      create: async ({ data }: { data: { eventType: string; envelope: { payload: unknown } } }) => {
        outbox.push({ eventType: data.eventType, envelope: data.envelope });
        return {};
      },
    },
  };

  return {
    holds,
    outbox,
    prisma: {
      read: {
        driver: { findUnique: async () => driverRow() },
        driverSuspensionHold: { findMany: holdClient.findMany },
      },
      write: {
        driver: { findUnique: tx.driver.findUnique },
        driverSuspensionHold: holdClient,
        $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      },
    },
  };
}

const redis = {} as never;
const bio = {} as never;
/**
 * Stub del RedisRefreshTokenStore (Lote 1b + backstop durable): suspendByCancellations llama revokeAllForUser
 * (fast-path, gateado) y resealRevokedBefore (backstop durable, INCONDICIONAL) post-commit.
 */
const sessions = { revokeAllForUser: async () => 0, resealRevokedBefore: async () => true } as never;
function svc(prisma: ReturnType<typeof makePrisma>): DriversService {
  return new DriversService(prisma.prisma as never, redis, bio, sessions, config);
}

function temporalHold(driverId: string, expiresAt: Date, createdAt = new Date('2026-06-23T00:00:00Z')): Hold {
  return {
    driverId,
    cause: SuspensionCause.EXCESSIVE_CANCELLATIONS,
    causeRef: '',
    reason: 'seed',
    createdAt,
    expiresAt,
  };
}

describe('DriversService.suspendByCancellations · hold TEMPORAL con expiresAt', () => {
  it('crea un hold EXCESSIVE_CANCELLATIONS con expiresAt = now + cooldown (24h)', async () => {
    const p = makePrisma();
    const before = Date.now();
    const created = await svc(p).suspendByCancellations('d1', 'exceso');
    expect(created).toBe(true);
    expect(p.holds).toHaveLength(1);
    const h = p.holds[0]!;
    expect(h.cause).toBe(SuspensionCause.EXCESSIVE_CANCELLATIONS);
    expect(h.expiresAt).not.toBeNull();
    const cooldownMs = h.expiresAt!.getTime() - before;
    // ~24h (con holgura por el tiempo de ejecución del test).
    expect(cooldownMs).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 5_000);
    expect(cooldownMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5_000);
  });

  it('GUARD: driver inexistente → no-op silencioso (anti poison-pill)', async () => {
    const p = makePrisma({ driverExists: false });
    const created = await svc(p).suspendByCancellations('ghost', 'exceso');
    expect(created).toBe(false);
    expect(p.holds).toHaveLength(0);
  });

  it('redelivery de Kafka NO extiende el cooldown (update no-op en conflicto)', async () => {
    const fixedExpiry = new Date(Date.now() + 5 * 60 * 60 * 1000); // 5h (un cooldown ya en curso)
    const p = makePrisma({ initialHolds: [temporalHold('d1', fixedExpiry)] });
    const created = await svc(p).suspendByCancellations('d1', 'exceso (re-entrega)');
    expect(created).toBe(false); // ya existía → no es suspensión nueva
    expect(p.holds).toHaveLength(1);
    // expiresAt SIGUE siendo el original (NO se movió a now+24h): el cooldown no se alarga con re-entregas.
    expect(p.holds[0]!.expiresAt!.getTime()).toBe(fixedExpiry.getTime());
  });
});

describe('DriversService.sweepExpiredHolds · el sweeper auto-levanta al vencer', () => {
  it('quita el hold vencido, recomputa y emite driver.reactivated (quedó con 0 holds)', async () => {
    const expired = new Date(Date.now() - 60 * 1000); // venció hace 1 min
    const p = makePrisma({ initialHolds: [temporalHold('d1', expired)] });
    const reactivated = await svc(p).sweepExpiredHolds();
    expect(reactivated).toBe(1);
    expect(p.holds).toHaveLength(0);
    expect(p.outbox).toHaveLength(1);
    expect(p.outbox[0]!.eventType).toBe('driver.reactivated');
    expect((p.outbox[0]!.envelope.payload as { driverId: string }).driverId).toBe('d1');
  });

  it('NO toca holds PERMANENTES (expiresAt null): un DISCIPLINARY queda intacto', async () => {
    const permanent: Hold = {
      driverId: 'd1',
      cause: SuspensionCause.DISCIPLINARY,
      causeRef: '',
      reason: 'seed',
      createdAt: new Date('2026-06-01T00:00:00Z'),
      expiresAt: null,
    };
    const p = makePrisma({ initialHolds: [permanent] });
    const reactivated = await svc(p).sweepExpiredHolds();
    expect(reactivated).toBe(0);
    expect(p.holds).toHaveLength(1); // el permanente sigue
    expect(p.outbox).toHaveLength(0);
  });

  it('vencido + permanente: quita el vencido pero NO emite reactivated (sigue suspendido por DISCIPLINARY)', async () => {
    const expired = new Date(Date.now() - 60 * 1000);
    const permanent: Hold = {
      driverId: 'd1',
      cause: SuspensionCause.DISCIPLINARY,
      causeRef: '',
      reason: 'seed',
      createdAt: new Date('2026-06-01T00:00:00Z'),
      expiresAt: null,
    };
    const p = makePrisma({ initialHolds: [temporalHold('d1', expired), permanent] });
    const reactivated = await svc(p).sweepExpiredHolds();
    expect(reactivated).toBe(0); // sigue suspendido por el DISCIPLINARY
    expect(p.holds).toHaveLength(1);
    expect(p.holds[0]!.cause).toBe(SuspensionCause.DISCIPLINARY);
    expect(p.outbox).toHaveLength(0); // no se reactivó → no se emite
  });

  it('idempotente: un hold ya removido → no-op (sweep posterior no emite)', async () => {
    const expired = new Date(Date.now() - 60 * 1000);
    const p = makePrisma({ initialHolds: [temporalHold('d1', expired)] });
    await svc(p).sweepExpiredHolds(); // primer sweep: reactiva
    const reactivated = await svc(p).sweepExpiredHolds(); // segundo: nada que hacer
    expect(reactivated).toBe(0);
    expect(p.outbox).toHaveLength(1); // solo el primero emitió
  });

  it('NO toca un hold temporal AÚN VIGENTE (expiresAt futuro)', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000); // vence en 1h
    const p = makePrisma({ initialHolds: [temporalHold('d1', future)] });
    const reactivated = await svc(p).sweepExpiredHolds();
    expect(reactivated).toBe(0);
    expect(p.holds).toHaveLength(1);
  });
});

describe('DriversService.reactivateForCompliance · el operador libera EXCESSIVE_CANCELLATIONS antes del vencimiento', () => {
  it('el override de compliance barre el hold temporal (cause != DISCIPLINARY) y emite driver.reactivated', async () => {
    const future = new Date(Date.now() + 5 * 60 * 60 * 1000); // cooldown aún en curso
    const p = makePrisma({ initialHolds: [temporalHold('d1', future)] });
    await svc(p).reactivateForCompliance('d1');
    expect(p.holds).toHaveLength(0); // levantado antes de vencer
    expect(p.outbox).toHaveLength(1);
    expect(p.outbox[0]!.eventType).toBe('driver.reactivated');
  });
});
