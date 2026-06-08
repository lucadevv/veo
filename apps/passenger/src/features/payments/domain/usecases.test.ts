import type { DebtView, PaymentView } from '@veo/api-client';
import type { PaymentsRepository } from './paymentsRepository';
import {
  ChangePaymentMethodUseCase,
  GetMyDebtsUseCase,
  GetPaymentUseCase,
  RetryChargeUseCase,
} from './usecases';

/** Doble de repositorio: solo lo que tocan los usecases de deuda; el resto son stubs no llamados. */
function makeRepo(overrides: Partial<PaymentsRepository>): PaymentsRepository {
  return {
    charge: jest.fn(),
    getPayment: jest.fn(),
    getMyDebts: jest.fn(),
    retryCharge: jest.fn(),
    getPaymentByTrip: jest.fn(),
    confirmCash: jest.fn(),
    addTip: jest.fn(),
    changePaymentMethod: jest.fn(),
    ...overrides,
  } as PaymentsRepository;
}

const DEBT_VIEW: DebtView = {
  hasDebt: true,
  totalCents: 1500,
  debts: [
    { paymentId: 'pay-1', tripId: 'trip-1', amountCents: 1500, reason: 'INSUFFICIENT_FUNDS', createdAt: '2026-06-01T10:00:00.000Z', kind: 'DEBT' },
  ],
};

describe('GetMyDebtsUseCase', () => {
  it('delega en el repositorio y devuelve la deuda tal cual (sin lógica propia)', async () => {
    const getMyDebts = jest.fn().mockResolvedValue(DEBT_VIEW);
    const usecase = new GetMyDebtsUseCase(makeRepo({ getMyDebts }));

    await expect(usecase.execute()).resolves.toBe(DEBT_VIEW);
    expect(getMyDebts).toHaveBeenCalledTimes(1);
  });
});

describe('RetryChargeUseCase', () => {
  it('re-cobra la deuda por su paymentId y propaga el PaymentView (CAPTURED → saldó directo)', async () => {
    const captured = { id: 'pay-1', status: 'CAPTURED' } as unknown as PaymentView;
    const retryCharge = jest.fn().mockResolvedValue(captured);
    const usecase = new RetryChargeUseCase(makeRepo({ retryCharge }));

    await expect(usecase.execute('pay-1')).resolves.toBe(captured);
    expect(retryCharge).toHaveBeenCalledWith('pay-1');
  });

  it('propaga el PENDING-con-checkout sin transformarlo (la presentación decide la rama)', async () => {
    const pending = {
      id: 'pay-1',
      status: 'PENDING',
      deepLink: 'yape://pay/abc',
    } as unknown as PaymentView;
    const usecase = new RetryChargeUseCase(makeRepo({ retryCharge: jest.fn().mockResolvedValue(pending) }));

    await expect(usecase.execute('pay-1')).resolves.toMatchObject({ status: 'PENDING' });
  });
});

describe('GetPaymentUseCase (poll del checkout)', () => {
  it('lee el cobro por id y lo devuelve (para esperar el CAPTURED del webhook)', async () => {
    const view = { id: 'pay-1', status: 'CAPTURED' } as unknown as PaymentView;
    const getPayment = jest.fn().mockResolvedValue(view);
    const usecase = new GetPaymentUseCase(makeRepo({ getPayment }));

    await expect(usecase.execute('pay-1')).resolves.toBe(view);
    expect(getPayment).toHaveBeenCalledWith('pay-1');
  });
});

describe('ChangePaymentMethodUseCase (TASK 3)', () => {
  it('delega en el repo con id + método y propaga el checkout nuevo (sin lógica propia)', async () => {
    const view = { id: 'pay-1', status: 'PENDING', method: 'PLIN' } as unknown as PaymentView;
    const changePaymentMethod = jest.fn().mockResolvedValue(view);
    const usecase = new ChangePaymentMethodUseCase(makeRepo({ changePaymentMethod }));

    await expect(usecase.execute('pay-1', 'PLIN')).resolves.toBe(view);
    expect(changePaymentMethod).toHaveBeenCalledWith('pay-1', 'PLIN');
  });
});
