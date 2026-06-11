/**
 * Tests del BARRIDO de Refunds PENDING viejos (ReconciliationService.sweepStalePendingRefunds) —
 * la red de seguridad del lazo de reembolsos S5 (BR-P06): un reverso cuyo callback se perdió (o cuyo
 * /reverse/new quedó en timeout sin uid) NO puede quedar invisible.
 *  - Sin refunds viejos → alerted=false, sin alertas.
 *  - Con refunds viejos → alerted=true, una alerta accionable por refund (id/pago/monto/uid/edad) +
 *    resumen con el TOTAL real (no acotado por el límite de detalle).
 *  - uid NULL (timeout de /reverse/new) → la alerta lo distingue (SIN_UID) del callback perdido.
 *  - El umbral (REFUND_PENDING_ALERT_MIN) define el corte de `createdAt` consultado.
 *  - NUNCA escribe: solo lectura + alerta (sin consulta de reverso en el puerto no hay cierre honesto).
 * Hermético: prisma/redis/gateway fakes (el barrido solo LEE y loguea; no es mutación de dinero).
 */
import { describe, it, expect, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { ReconciliationService } from './reconciliation.service';
import type { PrismaService } from '../infra/prisma.service';
import type { PaymentGateway } from '../ports/gateway/payment-gateway.port';

interface FakeRefundRow {
  id: string;
  paymentId: string;
  amountCents: number;
  externalRefundId: string | null;
  requestedBy: string;
  createdAt: Date;
}

interface RefundWhere {
  status: string;
  createdAt: { lt: Date };
}

function makeFakePrisma(rows: FakeRefundRow[]) {
  const refund = {
    count: vi.fn(async (_args: { where: RefundWhere }) => rows.length),
    findMany: vi.fn(async ({ take }: { where: RefundWhere; take: number }) => rows.slice(0, take)),
  };
  const client = { refund, payment: { findMany: vi.fn(async () => []) }, reconciliationRun: { create: vi.fn() } };
  return { prisma: { read: client, write: client } as unknown as PrismaService, refund };
}

const fakeRedis = { set: vi.fn(), del: vi.fn() } as unknown as Redis;
const fakeGateway = { charge: vi.fn(), getStatement: vi.fn(async () => []) } as unknown as PaymentGateway;

const fakeConfig = (over: Record<string, unknown> = {}) =>
  ({
    getOrThrow: (k: string) =>
      ({
        RECONCILIATION_ALERT_PCT: 0.01,
        REFUND_PENDING_ALERT_MIN: 60,
        ...over,
      })[k],
  }) as unknown as ConfigService<Record<string, unknown>, true>;

function build(rows: FakeRefundRow[], configOver: Record<string, unknown> = {}) {
  const { prisma, refund } = makeFakePrisma(rows);
  const svc = new ReconciliationService(prisma, fakeRedis, fakeGateway, fakeConfig(configOver) as never);
  return { svc, refund };
}

const NOW = new Date('2026-06-11T12:00:00.000Z');

function staleRow(over: Partial<FakeRefundRow> = {}): FakeRefundRow {
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

  it('consulta SOLO PENDING más viejos que el umbral (createdAt < now − REFUND_PENDING_ALERT_MIN)', async () => {
    const { svc, refund } = build([], { REFUND_PENDING_ALERT_MIN: 30 });
    await svc.sweepStalePendingRefunds(NOW);
    const where = refund.count.mock.calls[0]![0].where;
    expect(where.status).toBe('PENDING');
    expect(where.createdAt.lt.toISOString()).toBe(new Date(NOW.getTime() - 30 * 60_000).toISOString());
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

  it('NUNCA escribe: solo count+findMany de lectura (sin updates silenciosos al Refund/Payment)', async () => {
    const { svc, refund } = build([staleRow()]);
    vi.spyOn(svc['logger'], 'error').mockImplementation(() => undefined);
    await svc.sweepStalePendingRefunds(NOW);
    expect(refund.count).toHaveBeenCalledTimes(1);
    expect(refund.findMany).toHaveBeenCalledTimes(1);
    // El fake no define update/updateMany: si el barrido intentara escribir, explotaría acá.
  });
});
