/**
 * Tests del BARRIDO de Refunds PENDING viejos (ReconciliationService.sweepStalePendingRefunds) —
 * la red de seguridad del lazo de reembolsos S5 (BR-P06): un reverso cuyo callback se perdió (o cuyo
 * /reverse/new quedó en timeout sin uid) NO puede quedar invisible.
 *  - Sin refunds viejos → alerted=false, sin alertas.
 *  - Con refunds viejos → alerted=true, una alerta accionable por refund (id/pago/monto/uid/edad) +
 *    resumen con el TOTAL real (no acotado por el límite de detalle).
 *  - uid NULL (timeout de /reverse/new) → la alerta lo distingue (SIN_UID) del callback perdido.
 *  - El umbral (REFUND_PENDING_ALERT_MIN) define el corte de `createdAt` (el `threshold` pasado al repo).
 *  - NUNCA escribe: solo lecturas del repo + alerta (sin consulta de reverso en el puerto no hay cierre honesto).
 * Hermético: se MOCKEA EL REPO (seam de acceso a datos), no Prisma — el predicado `status=PENDING` es un
 * invariante del repo; el service solo decide el `threshold`. redis/gateway fakes (el barrido solo LEE y loguea).
 */
import { describe, it, expect, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { ReconciliationService } from './reconciliation.service';
import type {
  ReconciliationRepository,
  StaleRefundDetail,
  StaleCashDetail,
} from './reconciliation.repository';
import type { PaymentGateway } from '../ports/gateway/payment-gateway.port';

function makeRefundRepo(rows: StaleRefundDetail[]) {
  const repo = {
    countStalePendingRefunds: vi.fn(async (_threshold: Date) => rows.length),
    findStalePendingRefunds: vi.fn(async (_threshold: Date, take: number) => rows.slice(0, take)),
  };
  return repo;
}

const fakeRedis = { set: vi.fn(), del: vi.fn() } as unknown as Redis;
const fakeGateway = {
  charge: vi.fn(),
  getStatement: vi.fn(async () => []),
} as unknown as PaymentGateway;

const fakeConfig = (over: Record<string, unknown> = {}) =>
  ({
    getOrThrow: (k: string) =>
      ({
        RECONCILIATION_ALERT_PCT: 0.01,
        REFUND_PENDING_ALERT_MIN: 60,
        CASH_PENDING_ALERT_MIN: 1440,
        ...over,
      })[k],
  }) as unknown as ConfigService<Record<string, unknown>, true>;

function build(rows: StaleRefundDetail[], configOver: Record<string, unknown> = {}) {
  const repo = makeRefundRepo(rows);
  const svc = new ReconciliationService(
    repo as unknown as ReconciliationRepository,
    fakeRedis,
    fakeGateway,
    fakeConfig(configOver),
  );
  return { svc, repo };
}

const NOW = new Date('2026-06-11T12:00:00.000Z');

function staleRow(over: Partial<StaleRefundDetail> = {}): StaleRefundDetail {
  return {
    id: 'ref-1',
    paymentId: 'pay-1',
    amountCents: 500,
    externalRefundId: 'rev-uid-1',
    requestedBy: 'op-L2',
    createdAt: new Date(NOW.getTime() - 3 * 60 * 60_000), // 3h: bien pasado el umbral de 60min
    ...over,
  };
}

describe('ReconciliationService.sweepStalePendingRefunds · red de seguridad S5', () => {
  it('sin refunds PENDING viejos → alerted=false y staleCount=0', async () => {
    const { svc } = build([]);
    const res = await svc.sweepStalePendingRefunds(NOW);
    expect(res).toMatchObject({ staleCount: 0, alerted: false });
  });

  it('consulta con el umbral correcto (threshold = now − REFUND_PENDING_ALERT_MIN)', async () => {
    const { svc, repo } = build([], { REFUND_PENDING_ALERT_MIN: 30 });
    await svc.sweepStalePendingRefunds(NOW);
    const threshold = repo.countStalePendingRefunds.mock.calls[0]![0];
    expect(threshold.toISOString()).toBe(new Date(NOW.getTime() - 30 * 60_000).toISOString());
  });

  it('con refunds viejos → alerted=true + alerta accionable por refund (id/pago/monto/uid/edad) + resumen', async () => {
    const { svc } = build([staleRow()]);
    const errorSpy = vi.spyOn(svc['logger'], 'error');
    const res = await svc.sweepStalePendingRefunds(NOW);

    expect(res).toMatchObject({ staleCount: 1, alerted: true });
    expect(errorSpy).toHaveBeenCalledTimes(2); // 1 detalle + 1 resumen
    const detail = errorSpy.mock.calls[0]?.[0] as string;
    expect(detail).toContain('refund=ref-1');
    expect(detail).toContain('pago=pay-1');
    expect(detail).toContain('monto=500c');
    expect(detail).toContain('uid=rev-uid-1');
    expect(detail).toContain('edad=180min');
    const summary = errorSpy.mock.calls[1]?.[0] as string;
    expect(summary).toContain('1 refund(s)');
  });

  it('uid NULL (timeout de /reverse/new) → la alerta lo marca SIN_UID (camino de ops distinto)', async () => {
    const { svc } = build([staleRow({ externalRefundId: null })]);
    const errorSpy = vi.spyOn(svc['logger'], 'error');
    await svc.sweepStalePendingRefunds(NOW);
    expect(errorSpy.mock.calls[0]?.[0]).toContain('SIN_UID');
  });

  it('NUNCA escribe: solo count+findMany del repo (sin updates silenciosos al Refund/Payment)', async () => {
    const { svc, repo } = build([staleRow()]);
    vi.spyOn(svc['logger'], 'error').mockImplementation(() => undefined);
    await svc.sweepStalePendingRefunds(NOW);
    expect(repo.countStalePendingRefunds).toHaveBeenCalledTimes(1);
    expect(repo.findStalePendingRefunds).toHaveBeenCalledTimes(1);
    // El fake del repo no define ningún método de escritura: si el barrido intentara escribir, explotaría acá.
  });
});

// ── Barrido de EFECTIVO PENDING (sweepStaleCashPending) — gemelo del de refunds ──
function makeCashRepo(rows: StaleCashDetail[]) {
  const repo = {
    countStaleCashPending: vi.fn(async (_threshold: Date) => rows.length),
    findStaleCashPending: vi.fn(async (_threshold: Date, take: number) => rows.slice(0, take)),
  };
  return repo;
}

function buildCash(rows: StaleCashDetail[], configOver: Record<string, unknown> = {}) {
  const repo = makeCashRepo(rows);
  const svc = new ReconciliationService(
    repo as unknown as ReconciliationRepository,
    fakeRedis,
    fakeGateway,
    fakeConfig(configOver),
  );
  return { svc, repo };
}

function staleCashRow(over: Partial<StaleCashDetail> = {}): StaleCashDetail {
  return {
    id: 'pay-cash-1',
    tripId: 'trip-1',
    driverId: 'drv-1',
    passengerId: 'pax-1',
    amountCents: 1500,
    createdAt: new Date(NOW.getTime() - 30 * 60 * 60_000), // 30h: pasado el umbral de 24h
    ...over,
  };
}

describe('ReconciliationService.sweepStaleCashPending · red de seguridad del efectivo', () => {
  it('sin efectivo PENDING viejo → alerted=false y staleCount=0', async () => {
    const { svc } = buildCash([]);
    const res = await svc.sweepStaleCashPending(NOW);
    expect(res).toMatchObject({ staleCount: 0, alerted: false });
  });

  it('consulta con el umbral correcto (threshold = now − CASH_PENDING_ALERT_MIN)', async () => {
    const { svc, repo } = buildCash([], { CASH_PENDING_ALERT_MIN: 120 });
    await svc.sweepStaleCashPending(NOW);
    const threshold = repo.countStaleCashPending.mock.calls[0]![0];
    expect(threshold.toISOString()).toBe(new Date(NOW.getTime() - 120 * 60_000).toISOString());
  });

  it('con efectivo viejo → alerted=true + alerta accionable (pago/viaje/monto/conductor/pasajero/edad) + resumen', async () => {
    const { svc } = buildCash([staleCashRow()]);
    const errorSpy = vi.spyOn(svc['logger'], 'error');
    const res = await svc.sweepStaleCashPending(NOW);

    expect(res).toMatchObject({ staleCount: 1, alerted: true });
    expect(errorSpy).toHaveBeenCalledTimes(2); // 1 detalle + 1 resumen
    const detail = errorSpy.mock.calls[0]?.[0] as string;
    expect(detail).toContain('pago=pay-cash-1');
    expect(detail).toContain('viaje=trip-1');
    expect(detail).toContain('monto=1500c');
    expect(detail).toContain('conductor=drv-1');
    expect(detail).toContain('pasajero=pax-1');
    expect(detail).toContain('edad=1800min');
  });

  it('NUNCA captura: solo count+findMany del repo (sin auto-capture del efectivo sin OK del pasajero)', async () => {
    const { svc, repo } = buildCash([staleCashRow()]);
    vi.spyOn(svc['logger'], 'error').mockImplementation(() => undefined);
    await svc.sweepStaleCashPending(NOW);
    expect(repo.countStaleCashPending).toHaveBeenCalledTimes(1);
    expect(repo.findStaleCashPending).toHaveBeenCalledTimes(1);
    // El fake del repo no define ningún método de escritura: cualquier intento de captura explotaría acá.
  });
});

describe('ReconciliationService.listRuns · historial paginado (hueco #3 · solo lectura)', () => {
  function makeRun(id: string) {
    return {
      id,
      ranAt: new Date('2026-06-11T04:00:00.000Z'),
      discrepancyPct: 0.002,
      alerted: false,
      details: {
        periodStart: '2026-06-10T00:00:00.000Z',
        periodEnd: '2026-06-11T00:00:00.000Z',
        dbTotalCents: 100_000,
        statementTotalCents: 100_200,
        dbCount: 40,
        statementCount: 40,
      },
      createdAt: new Date('2026-06-11T04:00:00.000Z'),
    };
  }
  function buildWithRuns(runs: ReturnType<typeof makeRun>[]) {
    const listReconciliationRuns = vi.fn(
      async ({ take }: { cursor?: string; take: number }) => runs.slice(0, take),
    );
    const repo = { listReconciliationRuns };
    const svc = new ReconciliationService(
      repo as unknown as ReconciliationRepository,
      fakeRedis,
      fakeGateway,
      fakeConfig(),
    );
    return { svc, listReconciliationRuns };
  }

  it('pide limit+1 al repo (orden id desc es invariante del repo) y recorta a limit, devolviendo nextCursor cuando hay más', async () => {
    const runs = ['r5', 'r4', 'r3', 'r2', 'r1'].map(makeRun); // 5 corridas, id desc
    const { svc, listReconciliationRuns } = buildWithRuns(runs);
    const page = await svc.listRuns({ limit: 3 });
    expect(listReconciliationRuns).toHaveBeenCalledWith(expect.objectContaining({ take: 4 }));
    expect(page.items.map((r) => r.id)).toEqual(['r5', 'r4', 'r3']);
    expect(page.nextCursor).toBe('r3'); // id de la última fila de la página
  });

  it('sin más páginas → nextCursor null', async () => {
    const { svc } = buildWithRuns(['r2', 'r1'].map(makeRun));
    const page = await svc.listRuns({ limit: 30 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it('pasa el cursor al repo (filtro id < cursor · paginación estable)', async () => {
    const { svc, listReconciliationRuns } = buildWithRuns(['r1'].map(makeRun));
    await svc.listRuns({ cursor: 'r9', limit: 10 });
    expect(listReconciliationRuns).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'r9' }));
  });
});
