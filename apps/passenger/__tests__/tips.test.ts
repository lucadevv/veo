import type {
  AddTipRequest,
  CashConfirmRequest,
  ChargeRequest,
  PaymentView,
} from '@veo/api-client';
import type { PaymentsRepository } from '../src/features/payments/domain/paymentsRepository';
import {
  AddTipUseCase,
  MAX_TIP_CENTS,
  parseTipToCents,
  TipValidationError,
} from '../src/features/payments/domain/usecases';

class FakePaymentsRepository implements PaymentsRepository {
  charge = jest.fn(async (_input: ChargeRequest): Promise<PaymentView> => ({} as PaymentView));
  getPayment = jest.fn(async (): Promise<PaymentView> => ({} as PaymentView));
  confirmCash = jest.fn(
    async (_id: string, _input: CashConfirmRequest): Promise<PaymentView> => ({} as PaymentView),
  );
  addTip = jest.fn(
    async (tripId: string, input: AddTipRequest): Promise<PaymentView> =>
      ({ tripId, tipCents: input.tipCents } as PaymentView),
  );
}

const TRIP = '11111111-1111-1111-1111-111111111111';

describe('parseTipToCents', () => {
  it('convierte soles a céntimos (acepta coma o punto)', () => {
    expect(parseTipToCents('5')).toBe(500);
    expect(parseTipToCents('5.50')).toBe(550);
    expect(parseTipToCents('2,5')).toBe(250);
  });

  it('devuelve 0 para entradas vacías o no positivas', () => {
    expect(parseTipToCents('')).toBe(0);
    expect(parseTipToCents('abc')).toBe(0);
    expect(parseTipToCents('-3')).toBe(0);
    expect(parseTipToCents('0')).toBe(0);
  });
});

describe('AddTipUseCase', () => {
  it('envía la propina válida a POST /trips/:id/tip', async () => {
    const repo = new FakePaymentsRepository();
    const useCase = new AddTipUseCase(repo);

    const result = await useCase.execute(TRIP, 500);

    expect(repo.addTip).toHaveBeenCalledWith(TRIP, { tipCents: 500 });
    expect(result.tipCents).toBe(500);
  });

  it('rechaza montos no positivos, no enteros o sobre el tope', () => {
    const repo = new FakePaymentsRepository();
    const useCase = new AddTipUseCase(repo);

    expect(() => useCase.execute(TRIP, 0)).toThrow(TipValidationError);
    expect(() => useCase.execute(TRIP, -100)).toThrow(TipValidationError);
    expect(() => useCase.execute(TRIP, 12.5)).toThrow(TipValidationError);
    expect(() => useCase.execute(TRIP, MAX_TIP_CENTS + 1)).toThrow(TipValidationError);
    expect(repo.addTip).not.toHaveBeenCalled();
  });
});
