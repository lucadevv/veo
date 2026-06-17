import { describe, it, expect } from 'vitest';
import { ForbiddenError } from '@veo/utils';
import { PricingMode } from '@veo/shared-types';
import { PricingScheduleService } from './pricing-schedule.service';
import { AdminIdentityGuard } from './admin-identity.guard';
import type {
  PersistedSchedule,
  PricingScheduleRepository,
  ScheduleTx,
} from './pricing-schedule.repository';

interface CapturedOutbox {
  eventType: string;
  envelope: { eventType: string; payload: unknown };
}

/** Repo en memoria: guarda el singleton y captura el outbox encolado en la "transacción". */
function makeRepo(initial: PersistedSchedule | null) {
  let row: PersistedSchedule | null = initial;
  const outbox: CapturedOutbox[] = [];

  const updatedAt = new Date('2026-06-04T12:00:00.000Z');
  const writeData = (data: Record<string, unknown>) => {
    row = {
      defaultMode: data.defaultMode as PricingMode,
      rules: (data.rules as PersistedSchedule['rules']) ?? [],
      version: data.version as number,
      updatedAt: updatedAt.toISOString(),
    };
  };
  const tx: ScheduleTx = {
    pricingModeSchedule: {
      // CAS: "actualiza" solo si la fila existe y su versión coincide con el WHERE.
      updateMany: async ({ where, data }) => {
        if (row && row.version === where.version) {
          writeData(data);
          return { count: 1 };
        }
        return { count: 0 };
      },
      create: async ({ data }) => {
        writeData(data);
        return { version: data.version as number, updatedAt };
      },
      findUnique: async () => (row ? { version: row.version, updatedAt } : null),
    },
    outboxEvent: {
      create: async ({ data }) => {
        outbox.push({
          eventType: data.eventType,
          envelope: data.envelope as CapturedOutbox['envelope'],
        });
        return {};
      },
    },
  };

  let findCalls = 0;
  const repo: PricingScheduleRepository = {
    find: async () => {
      findCalls += 1;
      return row;
    },
    runInTx: async (fn) => fn(tx),
  };
  return {
    repo,
    outbox,
    get current() {
      return row;
    },
    get findCalls() {
      return findCalls;
    },
  };
}

describe('PricingScheduleService.getSchedule', () => {
  it('sin fila → DEFAULT (B5: FIXED, sin reglas, version 0)', async () => {
    const { repo } = makeRepo(null);
    const svc = new PricingScheduleService(repo);
    const schedule = await svc.getSchedule();
    expect(schedule.defaultMode).toBe(PricingMode.FIXED); // B5: default de sistema = precio fijo (ADR 011 invertido)
    expect(schedule.rules).toEqual([]);
    expect(schedule.version).toBe(0);
  });
});

describe('PricingScheduleService.replaceSchedule · PUT', () => {
  it('reemplaza wholesale, BUMPEA version y EMITE pricing.mode_schedule_updated', async () => {
    const initial: PersistedSchedule = {
      defaultMode: PricingMode.PUJA,
      rules: [],
      version: 3,
      updatedAt: new Date(0).toISOString(),
    };
    const { repo, outbox } = makeRepo(initial);
    const svc = new PricingScheduleService(repo);

    const result = await svc.replaceSchedule({
      defaultMode: PricingMode.PUJA,
      rules: [{ dayMask: 127, startMinute: 420, endMinute: 600, mode: PricingMode.FIXED }],
      expectedVersion: 3,
    });

    expect(result.version).toBe(4); // bump 3 → 4
    expect(result.rules).toHaveLength(1);
    const ev = outbox.find((e) => e.eventType === 'pricing.mode_schedule_updated');
    expect(ev).toBeTruthy();
    const payload = ev?.envelope.payload as { version: number; rules: unknown[]; defaultMode: string };
    expect(payload.version).toBe(4);
    expect(payload.rules).toHaveLength(1);
    expect(payload.defaultMode).toBe(PricingMode.PUJA);
  });

  it('primera escritura (sin fila previa, expectedVersion 0) → version 1', async () => {
    const { repo } = makeRepo(null);
    const svc = new PricingScheduleService(repo);
    const result = await svc.replaceSchedule({ defaultMode: PricingMode.FIXED, rules: [], expectedVersion: 0 });
    expect(result.version).toBe(1);
  });

  it('CAS · expectedVersion STALE → ConflictError (otro admin movió el schedule; sin lost update)', async () => {
    const initial: PersistedSchedule = {
      defaultMode: PricingMode.PUJA,
      rules: [],
      version: 9,
      updatedAt: new Date(0).toISOString(),
    };
    const { repo, outbox, current } = makeRepo(initial);
    void current;
    const svc = new PricingScheduleService(repo);
    await expect(
      svc.replaceSchedule({ defaultMode: PricingMode.FIXED, rules: [], expectedVersion: 8 }),
    ).rejects.toThrow(/cambió/);
    expect(outbox).toEqual([]);
  });
});

describe('PricingScheduleService.resolve · usa el resolver puro sobre el snapshot cargado', () => {
  it('regla FIXED 07:00–10:00 Lima matchea 08:00 Lima (13:00 UTC)', async () => {
    const initial: PersistedSchedule = {
      defaultMode: PricingMode.PUJA,
      rules: [{ dayMask: 127, startMinute: 420, endMinute: 600, mode: PricingMode.FIXED }],
      version: 1,
      updatedAt: new Date().toISOString(),
    };
    const { repo } = makeRepo(initial);
    const svc = new PricingScheduleService(repo);
    const mode = await svc.resolve('GLOBAL', new Date('2026-06-04T13:00:00.000Z'));
    expect(mode).toBe(PricingMode.FIXED);
  });

  it('sin fila cargada → FIXED (B5: default de sistema; degradación honesta)', async () => {
    const { repo } = makeRepo(null);
    const svc = new PricingScheduleService(repo);
    const mode = await svc.resolve('GLOBAL', new Date('2026-06-04T13:00:00.000Z'));
    expect(mode).toBe(PricingMode.FIXED); // B5: sin config → precio fijo (no puja)
  });
});

describe('PricingScheduleService · S3 · cache in-proc del schedule (espejo eligibility A4/H10)', () => {
  const FIXED_AT = new Date('2026-06-04T13:00:00.000Z'); // 08:00 Lima
  const initialFixed: PersistedSchedule = {
    defaultMode: PricingMode.PUJA,
    rules: [{ dayMask: 127, startMinute: 420, endMinute: 600, mode: PricingMode.FIXED }],
    version: 1,
    updatedAt: new Date(0).toISOString(),
  };

  it('dos resolve dentro del TTL → UN solo repo.find (el segundo sirve del cache)', async () => {
    const harness = makeRepo(initialFixed);
    const svc = new PricingScheduleService(harness.repo, 10_000);
    await svc.resolve('GLOBAL', FIXED_AT);
    await svc.resolve('GLOBAL', FIXED_AT);
    expect(harness.findCalls).toBe(1);
  });

  it('TTL=0 deshabilita el cache → cada resolve re-lee (dos finds)', async () => {
    const harness = makeRepo(initialFixed);
    const svc = new PricingScheduleService(harness.repo, 0);
    await svc.resolve('GLOBAL', FIXED_AT);
    await svc.resolve('GLOBAL', FIXED_AT);
    expect(harness.findCalls).toBe(2);
  });

  it('un PUT (replaceSchedule) INVALIDA el cache → el siguiente resolve re-lee y refleja el cambio', async () => {
    const harness = makeRepo(initialFixed);
    const svc = new PricingScheduleService(harness.repo, 10_000);

    // 1er resolve: regla FIXED activa a las 08:00 Lima → FIXED, y cachea.
    expect(await svc.resolve('GLOBAL', FIXED_AT)).toBe(PricingMode.FIXED);
    expect(harness.findCalls).toBe(1);

    // El admin REEMPLAZA el schedule por uno sin reglas (default PUJA). replaceSchedule hace su propio
    // find (current version) + invalida el cache del resolver.
    await svc.replaceSchedule({ defaultMode: PricingMode.PUJA, rules: [], expectedVersion: 1 });

    // El siguiente resolve NO debe servir el snapshot viejo cacheado: re-lee y ahora resuelve PUJA.
    const mode = await svc.resolve('GLOBAL', FIXED_AT);
    expect(mode).toBe(PricingMode.PUJA);
  });
});

describe('AdminIdentityGuard · defensa en profundidad (ADR 011 §6)', () => {
  function ctxWith(user: unknown) {
    return {
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as never;
  }

  it('identidad admin → permite', () => {
    const guard = new AdminIdentityGuard();
    expect(guard.canActivate(ctxWith({ type: 'admin' }))).toBe(true);
  });

  it('identidad NO admin (passenger) → 403 ForbiddenError', () => {
    const guard = new AdminIdentityGuard();
    expect(() => guard.canActivate(ctxWith({ type: 'passenger' }))).toThrow(ForbiddenError);
  });

  it('sin identidad → 403 ForbiddenError', () => {
    const guard = new AdminIdentityGuard();
    expect(() => guard.canActivate(ctxWith(undefined))).toThrow(ForbiddenError);
  });
});
