/**
 * Proxies de deuda del BFF (PaymentsService):
 *   - getMyDebts: reexpone GET /payments/debt como DebtView para el banner de la app.
 *   - retryCharge: ANTI-IDOR — lee el cobro por REST interno y valida ownership ANTES de re-cobrar;
 *     un cobro ajeno o inexistente → 404 (anti-enumeración). Tras saldar, invalida el cache "sin deuda".
 */
import { describe, it, expect, vi } from 'vitest';
import { NotFoundError } from '@veo/utils';
import { InternalAudience, type AuthenticatedUser } from '@veo/auth';
import type { GrpcServiceClient, InternalRestClient } from '@veo/rpc';
import type Redis from 'ioredis';
import { PaymentsService } from './payments.service';

const SECRET = 'dev-internal-secret-change-me';
const user: AuthenticatedUser = { userId: 'usr-1', type: 'passenger', roles: [], sessionId: 's1' };

function makeService(rest: Partial<InternalRestClient>) {
  const grpcStub = {} as unknown as GrpcServiceClient;
  const redis = { get: vi.fn(), set: vi.fn(), del: vi.fn().mockResolvedValue(1) };
  const svc = new PaymentsService(
    grpcStub,
    grpcStub,
    rest as InternalRestClient,
    SECRET,
    InternalAudience.PUBLIC_RAIL,
    redis as unknown as Redis,
  );
  return { svc, redis };
}

describe('PaymentsService.getMyDebts (banner de la app)', () => {
  it('mapea el resumen de payment a DebtView', async () => {
    const get = vi.fn().mockResolvedValue({
      hasDebt: true,
      totalCents: 3500,
      debts: [
        {
          paymentId: 'p1',
          tripId: 't1',
          amountCents: 1000,
          reason: 'yape_insufficient_funds',
          createdAt: '2026-06-01T00:00:00Z',
        },
        {
          paymentId: 'p2',
          tripId: 't2',
          amountCents: 2500,
          reason: 'declined_by_provider',
          createdAt: '2026-06-05T00:00:00Z',
        },
      ],
    });
    const { svc } = makeService({ get });
    const out = await svc.getMyDebts(user);
    expect(get).toHaveBeenCalledWith('/payments/debt', { identity: user });
    expect(out.hasDebt).toBe(true);
    expect(out.totalCents).toBe(3500);
    expect(out.debts).toHaveLength(2);
    expect(out.debts[0]).toMatchObject({ paymentId: 'p1', tripId: 't1', amountCents: 1000 });
  });

  it('sin deuda → hasDebt=false', async () => {
    const get = vi.fn().mockResolvedValue({ hasDebt: false, totalCents: 0, debts: [] });
    const { svc } = makeService({ get });
    const out = await svc.getMyDebts(user);
    expect(out.hasDebt).toBe(false);
    expect(out.debts).toEqual([]);
  });

  it('propaga kind por ítem (DEBT + PENDING_ACTION) sin que el PENDING_ACTION dispare hasDebt', async () => {
    const get = vi.fn().mockResolvedValue({
      hasDebt: false, // payment-service ya garantiza hasDebt solo-DEBT
      totalCents: 0,
      debts: [
        {
          paymentId: 'pa1',
          tripId: 'tp1',
          amountCents: 3600,
          reason: '',
          createdAt: '2026-06-02T00:00:00Z',
          kind: 'PENDING_ACTION',
        },
      ],
    });
    const { svc } = makeService({ get });
    const out = await svc.getMyDebts(user);
    expect(out.hasDebt).toBe(false);
    expect(out.debts[0]).toMatchObject({ paymentId: 'pa1', kind: 'PENDING_ACTION' });
  });

  it('propaga una CANCELLATION_PENALTY (penaltyId, sin paymentId) y dispara hasDebt (F2)', async () => {
    const get = vi.fn().mockResolvedValue({
      hasDebt: true, // payment-service ya cuenta la penalidad PENDING como bloqueante
      totalCents: 800,
      debts: [
        {
          penaltyId: 'pen-1',
          tripId: 'tc1',
          amountCents: 800,
          reason: 'no_show',
          createdAt: '2026-06-07T00:00:00Z',
          kind: 'CANCELLATION_PENALTY',
        },
      ],
    });
    const { svc } = makeService({ get });
    const out = await svc.getMyDebts(user);
    expect(out.hasDebt).toBe(true);
    expect(out.totalCents).toBe(800);
    expect(out.debts[0]).toMatchObject({
      penaltyId: 'pen-1',
      tripId: 'tc1',
      amountCents: 800,
      kind: 'CANCELLATION_PENALTY',
    });
    expect(out.debts[0]?.paymentId).toBeUndefined();
  });

  it('ítem sin kind (payment-service viejo) → se trata como DEBT (defensivo)', async () => {
    const get = vi.fn().mockResolvedValue({
      hasDebt: true,
      totalCents: 1000,
      debts: [
        {
          paymentId: 'p1',
          tripId: 't1',
          amountCents: 1000,
          reason: 'declined',
          createdAt: '2026-06-01T00:00:00Z',
        },
      ],
    });
    const { svc } = makeService({ get });
    const out = await svc.getMyDebts(user);
    expect(out.debts[0]?.kind).toBe('DEBT');
  });
});

describe('PaymentsService.retryCharge (saldar deuda · anti-IDOR)', () => {
  const PAYMENT_VIEW_REPLY = {
    id: 'pay-1',
    tripId: 'trip-1',
    method: 'YAPE',
    status: 'PENDING',
    amountCents: 2300,
    grossCents: 2000,
    tipCents: 0,
    commissionCents: 400,
    feeCents: 400,
    externalRef: null,
    externalUid: 'uid-new',
    checkoutUrl: 'https://pay/new',
    qrCode: null,
    deepLink: null,
    cip: null,
    checkoutExpiresAt: null,
  };

  it('cobro propio → re-cobra y devuelve PaymentView; invalida el cache "sin deuda"', async () => {
    const get = vi.fn().mockResolvedValue({ passengerId: 'usr-1' }); // ownership OK
    const post = vi.fn().mockResolvedValue(PAYMENT_VIEW_REPLY);
    const { svc, redis } = makeService({ get, post });

    const out = await svc.retryCharge(user, 'pay-1');
    expect(get).toHaveBeenCalledWith('/payments/pay-1', { identity: user });
    expect(post).toHaveBeenCalledWith('/payments/pay-1/retry-charge', { identity: user });
    expect(out.id).toBe('pay-1');
    expect(out.status).toBe('PENDING');
    expect(out.checkoutUrl).toBe('https://pay/new');
    expect(redis.del).toHaveBeenCalledWith('debt:none:usr-1');
  });

  it('cobro de OTRO pasajero → 404 (anti-enumeración) y NO re-cobra', async () => {
    const get = vi.fn().mockResolvedValue({ passengerId: 'usr-OTHER' });
    const post = vi.fn();
    const { svc } = makeService({ get, post });
    await expect(svc.retryCharge(user, 'pay-ajeno')).rejects.toBeInstanceOf(NotFoundError);
    expect(post).not.toHaveBeenCalled();
  });

  it('cobro sin passengerId (legacy) → 404 (no se puede acreditar pertenencia)', async () => {
    const get = vi.fn().mockResolvedValue({ passengerId: null });
    const post = vi.fn();
    const { svc } = makeService({ get, post });
    await expect(svc.retryCharge(user, 'pay-legacy')).rejects.toBeInstanceOf(NotFoundError);
    expect(post).not.toHaveBeenCalled();
  });

  it('cobro inexistente (el GET interno falla) → 404 y NO re-cobra', async () => {
    const get = vi.fn().mockRejectedValue(new NotFoundError('Pago no encontrado'));
    const post = vi.fn();
    const { svc } = makeService({ get, post });
    await expect(svc.retryCharge(user, 'pay-nope')).rejects.toBeInstanceOf(NotFoundError);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('PaymentsService.settlePenalty (pagar penalidad de cancelación · F2.3)', () => {
  const SETTLEMENT_REPLY = {
    id: 'pay-pen-1',
    tripId: 'trip-cancelled',
    method: 'YAPE',
    status: 'CAPTURED',
    amountCents: 800,
    grossCents: 800,
    tipCents: 0,
    commissionCents: 0,
    feeCents: 0,
    externalRef: null,
    externalUid: null,
    checkoutUrl: null,
    qrCode: null,
    deepLink: null,
    cip: null,
    checkoutExpiresAt: null,
  };

  it('forward a payment-service con la identidad firmada (sin pre-check de ownership) e invalida el cache "sin deuda"', async () => {
    const post = vi.fn().mockResolvedValue(SETTLEMENT_REPLY);
    const { svc, redis } = makeService({ post });

    const out = await svc.settlePenalty(user, 'pen-1', 'YAPE', '999111222');
    // El anti-IDOR vive en payment-service (resuelve por passengerId firmado) → el BFF NO lee el Payment antes.
    expect(post).toHaveBeenCalledWith('/payments/penalties/pen-1/settle', {
      identity: user,
      body: { method: 'YAPE', payerRef: '999111222' },
    });
    expect(out.id).toBe('pay-pen-1');
    expect(out.status).toBe('CAPTURED');
    // El estado de deuda cambió → invalida el cache del gate para que reconsulte.
    expect(redis.del).toHaveBeenCalledWith('debt:none:usr-1');
  });

  it('propaga el error de payment-service (404 penalidad ajena/inexistente) sin invalidar a ciegas', async () => {
    const post = vi.fn().mockRejectedValue(new NotFoundError('Penalidad no encontrada'));
    const { svc, redis } = makeService({ post });
    await expect(svc.settlePenalty(user, 'pen-ajena', 'YAPE')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(redis.del).not.toHaveBeenCalled();
  });
});

describe('PaymentsService.changeMethod (cambiar método de un pago pendiente · anti-IDOR)', () => {
  const PAYMENT_VIEW_REPLY = {
    id: 'pay-1',
    tripId: 'trip-1',
    method: 'PLIN', // ya cambiado por el servicio
    status: 'PENDING',
    amountCents: 2300,
    grossCents: 2000,
    tipCents: 0,
    commissionCents: 400,
    feeCents: 400,
    externalRef: null,
    externalUid: 'uid-new',
    checkoutUrl: 'https://pay/new',
    qrCode: null,
    deepLink: null,
    cip: null,
    checkoutExpiresAt: null,
  };

  it('cobro propio → cambia método y devuelve PaymentView; invalida el cache "sin deuda"', async () => {
    const get = vi.fn().mockResolvedValue({ passengerId: 'usr-1' }); // ownership OK
    const post = vi.fn().mockResolvedValue(PAYMENT_VIEW_REPLY);
    const { svc, redis } = makeService({ get, post });

    const out = await svc.changeMethod(user, 'pay-1', 'PLIN');
    expect(get).toHaveBeenCalledWith('/payments/pay-1', { identity: user });
    expect(post).toHaveBeenCalledWith('/payments/pay-1/method', {
      identity: user,
      body: { method: 'PLIN' },
    });
    expect(out.id).toBe('pay-1');
    expect(out.method).toBe('PLIN');
    expect(out.checkoutUrl).toBe('https://pay/new');
    expect(redis.del).toHaveBeenCalledWith('debt:none:usr-1');
  });

  it('cobro de OTRO pasajero → 404 (anti-enumeración) y NO cambia método', async () => {
    const get = vi.fn().mockResolvedValue({ passengerId: 'usr-OTHER' });
    const post = vi.fn();
    const { svc } = makeService({ get, post });
    await expect(svc.changeMethod(user, 'pay-ajeno', 'PLIN')).rejects.toBeInstanceOf(NotFoundError);
    expect(post).not.toHaveBeenCalled();
  });

  it('cobro sin passengerId (legacy) → 404 (no se puede acreditar pertenencia)', async () => {
    const get = vi.fn().mockResolvedValue({ passengerId: null });
    const post = vi.fn();
    const { svc } = makeService({ get, post });
    await expect(svc.changeMethod(user, 'pay-legacy', 'PLIN')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('cobro inexistente (el GET interno falla) → 404 y NO cambia método', async () => {
    const get = vi.fn().mockRejectedValue(new NotFoundError('Pago no encontrado'));
    const post = vi.fn();
    const { svc } = makeService({ get, post });
    await expect(svc.changeMethod(user, 'pay-nope', 'PLIN')).rejects.toBeInstanceOf(NotFoundError);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('ChangeMethodDto (validación class-validator · solo digitales)', () => {
  it('acepta YAPE/PLIN/CARD/PAGOEFECTIVO y rechaza CASH y valores fuera de la lista', async () => {
    const { validate } = await import('class-validator');
    const { plainToInstance } = await import('class-transformer');
    const { ChangeMethodDto } = await import('./dto/payments.dto');

    for (const method of ['YAPE', 'PLIN', 'CARD', 'PAGOEFECTIVO']) {
      const errs = await validate(plainToInstance(ChangeMethodDto, { method }));
      expect(errs).toHaveLength(0);
    }
    for (const bad of ['CASH', 'BTC', '', undefined]) {
      const errs = await validate(plainToInstance(ChangeMethodDto, { method: bad }));
      expect(errs.length).toBeGreaterThan(0);
    }
  });
});
