import {
  ApiError,
  type DebtView,
  debtView,
  type HttpClient,
  type PaymentView,
} from '@veo/api-client';
import {HttpPaymentsRepository} from './httpPaymentsRepository';
import {
  PaymentMethodNotApplicableError,
  PaymentNotChangeableError,
} from '../domain/usecases';

/** Doble mínimo de HttpClient: solo los verbos que usa el repo de pagos. */
function makeHttp(overrides: Partial<HttpClient>): HttpClient {
  return {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    ...overrides,
  } as unknown as HttpClient;
}

const DEBT_VIEW: DebtView = {
  hasDebt: true,
  totalCents: 2300,
  debts: [
    {
      paymentId: 'pay-1',
      tripId: 'trip-1',
      amountCents: 1500,
      reason: 'INSUFFICIENT_FUNDS',
      createdAt: '2026-06-01T10:00:00.000Z',
      kind: 'DEBT',
    },
    {
      paymentId: 'pay-2',
      tripId: 'trip-2',
      amountCents: 800,
      reason: 'DECLINED',
      createdAt: '2026-06-03T12:00:00.000Z',
      kind: 'DEBT',
    },
    // Pago por completar (PENDING con checkout vivo): viaja en la lista pero NO suma a totalCents/hasDebt.
    {
      paymentId: 'pay-3',
      tripId: 'trip-3',
      amountCents: 3600,
      reason: '',
      createdAt: '2026-06-04T09:00:00.000Z',
      kind: 'PENDING_ACTION',
    },
  ],
};

const CAPTURED_PAYMENT = {
  id: 'pay-1',
  status: 'CAPTURED',
} as unknown as PaymentView;

describe('HttpPaymentsRepository · deuda (BR-P02)', () => {
  it('getMyDebts pega a GET /payments/debts con el schema de deuda', async () => {
    const get = jest.fn().mockResolvedValue(DEBT_VIEW);
    const repo = new HttpPaymentsRepository(makeHttp({get}));

    await expect(repo.getMyDebts()).resolves.toMatchObject({
      hasDebt: true,
      totalCents: 2300,
    });
    expect(get).toHaveBeenCalledWith(
      '/payments/debts',
      expect.objectContaining({schema: expect.anything()}),
    );
  });

  it('getUserCredit pega a GET /payments/credit con el schema de saldo', async () => {
    const get = jest.fn().mockResolvedValue({balanceCents: 1500});
    const repo = new HttpPaymentsRepository(makeHttp({get}));

    await expect(repo.getUserCredit()).resolves.toMatchObject({
      balanceCents: 1500,
    });
    expect(get).toHaveBeenCalledWith(
      '/payments/credit',
      expect.objectContaining({schema: expect.anything()}),
    );
  });

  it('retryCharge pega a POST /payments/:id/retry-charge SIN body (el bff deriva la idempotencia)', async () => {
    const post = jest.fn().mockResolvedValue(CAPTURED_PAYMENT);
    const repo = new HttpPaymentsRepository(makeHttp({post}));

    await expect(repo.retryCharge('pay-1')).resolves.toMatchObject({
      status: 'CAPTURED',
    });
    expect(post).toHaveBeenCalledWith(
      '/payments/pay-1/retry-charge',
      expect.objectContaining({schema: expect.anything()}),
    );
    // El cobro es canónico (un Payment por viaje): NO mandamos dedupKey propia (la deriva el bff).
    const opts = post.mock.calls[0][1] as {
      body?: unknown;
      idempotencyKey?: unknown;
    };
    expect(opts.body).toBeUndefined();
    expect(opts.idempotencyKey).toBeUndefined();
  });

  it('retryCharge propaga el 404 anti-IDOR sin envolverlo (cobro ajeno/inexistente)', async () => {
    const boom = new ApiError(404, 'NOT_FOUND', 'no es tuyo');
    const repo = new HttpPaymentsRepository(
      makeHttp({post: jest.fn().mockRejectedValue(boom)}),
    );

    await expect(repo.retryCharge('pay-ajeno')).rejects.toBe(boom);
  });

  it('el contrato parsea un ítem CANCELLATION_PENALTY SIN paymentId (viene con penaltyId)', () => {
    // Regresión del soft-lock: el backend emite penalidades de cancelación con `penaltyId` y SIN
    // `paymentId`. El schema viejo (paymentId requerido + kind sin CANCELLATION_PENALTY) reventaba el
    // parse → DebtSheet en "S/ 0.00" sin ítems con el gate server-side bloqueando viajes nuevos.
    const parsed = debtView.parse({
      hasDebt: true,
      totalCents: 300,
      debts: [
        {
          penaltyId: 'pen-1',
          tripId: 'trip-9',
          amountCents: 300,
          reason: 'cancellation',
          createdAt: '2026-07-10T15:00:00.000Z',
          kind: 'CANCELLATION_PENALTY',
        },
      ],
    });
    expect(parsed.debts[0]).toMatchObject({
      penaltyId: 'pen-1',
      kind: 'CANCELLATION_PENALTY',
    });
    expect(parsed.debts[0]?.paymentId).toBeUndefined();
  });

  it('settlePenalty pega a POST /payments/penalties/:id/settle con body { method }', async () => {
    const post = jest.fn().mockResolvedValue(CAPTURED_PAYMENT);
    const repo = new HttpPaymentsRepository(makeHttp({post}));

    await expect(repo.settlePenalty('pen-1', 'YAPE')).resolves.toMatchObject({
      status: 'CAPTURED',
    });
    expect(post).toHaveBeenCalledWith(
      '/payments/penalties/pen-1/settle',
      expect.objectContaining({
        body: {method: 'YAPE'},
        schema: expect.anything(),
      }),
    );
  });

  it('settlePenalty propaga el 404 anti-IDOR sin envolverlo (penalidad ajena/inexistente)', async () => {
    const boom = new ApiError(404, 'NOT_FOUND', 'no es tuya');
    const repo = new HttpPaymentsRepository(
      makeHttp({post: jest.fn().mockRejectedValue(boom)}),
    );

    await expect(repo.settlePenalty('pen-ajena', 'PLIN')).rejects.toBe(boom);
  });

  it('getPayment (poll del checkout) pega a GET /payments/:id', async () => {
    const get = jest.fn().mockResolvedValue(CAPTURED_PAYMENT);
    const repo = new HttpPaymentsRepository(makeHttp({get}));

    await expect(repo.getPayment('pay-1')).resolves.toMatchObject({
      id: 'pay-1',
    });
    expect(get).toHaveBeenCalledWith(
      '/payments/pay-1',
      expect.objectContaining({schema: expect.anything()}),
    );
  });
});

describe('HttpPaymentsRepository · changePaymentMethod (TASK 3)', () => {
  const NEW_CHECKOUT = {
    id: 'pay-1',
    status: 'PENDING',
    method: 'PLIN',
  } as unknown as PaymentView;

  it('pega a POST /payments/:id/method con body { method } y devuelve el checkout nuevo', async () => {
    const post = jest.fn().mockResolvedValue(NEW_CHECKOUT);
    const repo = new HttpPaymentsRepository(makeHttp({post}));

    await expect(
      repo.changePaymentMethod('pay-1', 'PLIN'),
    ).resolves.toMatchObject({
      method: 'PLIN',
    });
    expect(post).toHaveBeenCalledWith(
      '/payments/pay-1/method',
      expect.objectContaining({
        body: {method: 'PLIN'},
        schema: expect.anything(),
      }),
    );
  });

  it('422 → PaymentMethodNotApplicableError (el método no aplica: CASH)', async () => {
    const post = jest
      .fn()
      .mockRejectedValue(new ApiError(422, 'CASH_NOT_ALLOWED', 'no aplica'));
    const repo = new HttpPaymentsRepository(makeHttp({post}));

    await expect(
      repo.changePaymentMethod('pay-1', 'YAPE'),
    ).rejects.toBeInstanceOf(PaymentMethodNotApplicableError);
  });

  it('409 → PaymentNotChangeableError (el pago ya no es cambiable)', async () => {
    const post = jest
      .fn()
      .mockRejectedValue(new ApiError(409, 'NOT_CHANGEABLE', 'ya capturó'));
    const repo = new HttpPaymentsRepository(makeHttp({post}));

    await expect(
      repo.changePaymentMethod('pay-1', 'CARD'),
    ).rejects.toBeInstanceOf(PaymentNotChangeableError);
  });

  it('otros errores (404 anti-IDOR) se propagan sin envolver', async () => {
    const boom = new ApiError(404, 'NOT_FOUND', 'no es tuyo');
    const repo = new HttpPaymentsRepository(
      makeHttp({post: jest.fn().mockRejectedValue(boom)}),
    );

    await expect(repo.changePaymentMethod('pay-ajeno', 'YAPE')).rejects.toBe(
      boom,
    );
  });
});
