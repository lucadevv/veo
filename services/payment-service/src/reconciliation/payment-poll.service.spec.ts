/**
 * Tests del POLL FALLBACK (PaymentPollService.pollOnce): consulta el estado de los pagos PENDING con
 * externalUid y aplica el desenlace por el camino idempotente de applyWebhookResult.
 *  - CONFIRMED → aplica (captura).
 *  - PENDING   → no aplica (sigue en curso).
 *  - found=false (uid no reconocido) → no aplica, no rompe.
 *  - errores de consulta de un pago no abortan el barrido.
 * Hermético: prisma/gateway/payments fake; el flag `running` se fuerza para permitir el barrido.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PaymentPollService } from './payment-poll.service';
import type { PrismaService } from '../infra/prisma.service';
import type { PaymentsService } from '../payments/payments.service';
import type { PaymentGateway, PaymentStatusDetail } from '../ports/gateway/payment-gateway.port';
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';

function makeFakePrisma(rows: { id: string; externalUid: string | null }[]) {
  const client = {
    payment: {
      findMany: vi.fn(async ({ take }: { take: number }) => rows.slice(0, take)),
    },
  };
  return { read: client, write: client } as unknown as PrismaService;
}

/** Gateway fake con consulta de estado configurable por uid. */
function makeGateway(byUid: Record<string, PaymentStatusDetail>): PaymentGateway & {
  getPaymentStatus: (uid: string) => Promise<PaymentStatusDetail>;
} {
  return {
    charge: vi.fn(),
    getStatement: vi.fn(),
    getPaymentStatus: vi.fn(async (uid: string) => {
      const d = byUid[uid];
      if (!d) throw new Error(`boom-${uid}`);
      return d;
    }),
  } as unknown as PaymentGateway & { getPaymentStatus: (uid: string) => Promise<PaymentStatusDetail> };
}

const fakeConfig = (over: Record<string, unknown> = {}) =>
  ({
    getOrThrow: (k: string) =>
      ({
        VEO_PAYMENT_MODE: 'prontopaga',
        PRONTOPAGA_POLL_ENABLED: true,
        PRONTOPAGA_POLL_INTERVAL_MS: 25_000,
        PRONTOPAGA_POLL_MAX_AGE_MIN: 60,
        PRONTOPAGA_POLL_BATCH: 25,
        ...over,
      })[k],
  }) as unknown as ConfigService<Record<string, unknown>, true>;

const fakeScheduler = { addInterval: vi.fn(), deleteInterval: vi.fn(), doesExist: vi.fn(() => false) } as unknown as SchedulerRegistry;
const fakeRedis = { set: vi.fn(), del: vi.fn() } as unknown as Redis;

function build(
  rows: { id: string; externalUid: string | null }[],
  byUid: Record<string, PaymentStatusDetail>,
  applyImpl?: PaymentsService['applyWebhookResult'],
) {
  const applyWebhookResult = vi.fn(applyImpl ?? (async () => ({ applied: true, status: 'CAPTURED' })));
  const payments = { applyWebhookResult } as unknown as PaymentsService;
  const svc = new PaymentPollService(
    makeFakePrisma(rows),
    fakeRedis,
    makeGateway(byUid),
    payments,
    fakeScheduler,
    fakeConfig(),
  );
  // pollOnce respeta el corte si !running; lo activamos para el barrido del test.
  (svc as unknown as { running: boolean }).running = true;
  return { svc, applyWebhookResult };
}

describe('PaymentPollService.pollOnce · poll fallback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('CONFIRMED → llama applyWebhookResult con el camino idempotente y cuenta el aplicado', async () => {
    const { svc, applyWebhookResult } = build(
      [{ id: 'pay-1', externalUid: 'U1' }],
      { U1: { found: true, status: 'CONFIRMED', rawStatus: 'success' } },
    );
    const res = await svc.pollOnce();
    expect(applyWebhookResult).toHaveBeenCalledWith({ paymentId: 'pay-1', externalUid: 'U1', status: 'CONFIRMED' });
    expect(res).toEqual({ scanned: 1, applied: 1 });
  });

  it('PENDING → NO aplica (el cobro sigue en curso)', async () => {
    const { svc, applyWebhookResult } = build(
      [{ id: 'pay-1', externalUid: 'U1' }],
      { U1: { found: true, status: 'PENDING', rawStatus: 'created' } },
    );
    const res = await svc.pollOnce();
    expect(applyWebhookResult).not.toHaveBeenCalled();
    expect(res).toEqual({ scanned: 1, applied: 0 });
  });

  it('found=false (uid no reconocido) → NO aplica y no rompe', async () => {
    const { svc, applyWebhookResult } = build(
      [{ id: 'pay-1', externalUid: 'U1' }],
      { U1: { found: false, status: 'PENDING' } },
    );
    const res = await svc.pollOnce();
    expect(applyWebhookResult).not.toHaveBeenCalled();
    expect(res.applied).toBe(0);
  });

  it('un error de consulta en un pago NO aborta el barrido del resto', async () => {
    const { svc, applyWebhookResult } = build(
      [
        { id: 'pay-err', externalUid: 'BAD' }, // el gateway fake lanza para uid desconocido
        { id: 'pay-ok', externalUid: 'U2' },
      ],
      { U2: { found: true, status: 'CONFIRMED', rawStatus: 'success' } },
    );
    const res = await svc.pollOnce();
    expect(applyWebhookResult).toHaveBeenCalledTimes(1);
    expect(applyWebhookResult).toHaveBeenCalledWith({ paymentId: 'pay-ok', externalUid: 'U2', status: 'CONFIRMED' });
    expect(res).toEqual({ scanned: 2, applied: 1 });
  });

  it('sin pagos PENDING con uid → no-op', async () => {
    const { svc, applyWebhookResult } = build([], {});
    const res = await svc.pollOnce();
    expect(applyWebhookResult).not.toHaveBeenCalled();
    expect(res).toEqual({ scanned: 0, applied: 0 });
  });
});

describe('PaymentPollService · activación', () => {
  it('en modo sandbox NO registra el intervalo (nada que consultar)', () => {
    const addInterval = vi.fn();
    const svc = new PaymentPollService(
      makeFakePrisma([]),
      fakeRedis,
      makeGateway({}),
      {} as unknown as PaymentsService,
      { addInterval, deleteInterval: vi.fn(), doesExist: vi.fn(() => false) } as unknown as SchedulerRegistry,
      fakeConfig({ VEO_PAYMENT_MODE: 'sandbox' }),
    );
    svc.onModuleInit();
    expect(addInterval).not.toHaveBeenCalled();
  });

  it('en modo prontopaga con gateway que consulta → registra el intervalo', () => {
    const addInterval = vi.fn();
    const handles: NodeJS.Timeout[] = [];
    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation((() => {
      const h = 1 as unknown as NodeJS.Timeout;
      handles.push(h);
      return h;
    }) as typeof setInterval);
    const svc = new PaymentPollService(
      makeFakePrisma([]),
      fakeRedis,
      makeGateway({}),
      {} as unknown as PaymentsService,
      { addInterval, deleteInterval: vi.fn(), doesExist: vi.fn(() => false) } as unknown as SchedulerRegistry,
      fakeConfig(),
    );
    svc.onModuleInit();
    expect(addInterval).toHaveBeenCalledWith('prontopaga-payment-poll', expect.anything());
    expect(setIntervalSpy).toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });
});
