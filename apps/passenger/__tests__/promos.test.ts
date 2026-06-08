import type { PromoValidationView } from '@veo/api-client';
import { applyDiscount, normalizePromoCode } from '../src/features/promos/domain/entities';
import type { PromosRepository } from '../src/features/promos/domain/promosRepository';
import { PromoInputError, ValidatePromoUseCase } from '../src/features/promos/domain/usecases';

class FakePromosRepository implements PromosRepository {
  validate = jest.fn(
    async (code: string, fareCents: number): Promise<PromoValidationView> => ({
      code,
      kind: 'PERCENTAGE',
      valid: true,
      discountCents: Math.round(fareCents * 0.2),
    }),
  );
}

describe('normalizePromoCode', () => {
  it('recorta, quita espacios internos y pasa a mayúsculas', () => {
    expect(normalizePromoCode('  ve o20 ')).toBe('VEO20');
  });
});

describe('applyDiscount', () => {
  it('resta el descuento sin bajar de cero', () => {
    expect(applyDiscount(1500, 300)).toBe(1200);
    expect(applyDiscount(1000, 4000)).toBe(0);
  });
});

describe('ValidatePromoUseCase', () => {
  it('normaliza el código y valida contra la tarifa entera', async () => {
    const repo = new FakePromosRepository();
    const useCase = new ValidatePromoUseCase(repo);

    const result = await useCase.execute('  veo20 ', 1500.9);

    expect(repo.validate).toHaveBeenCalledWith('VEO20', 1500);
    expect(result.valid).toBe(true);
    expect(result.discountCents).toBe(300);
  });

  it('rechaza un código vacío sin llamar al repo', () => {
    const repo = new FakePromosRepository();
    const useCase = new ValidatePromoUseCase(repo);

    expect(() => useCase.execute('   ', 1500)).toThrow(PromoInputError);
    expect(repo.validate).not.toHaveBeenCalled();
  });

  it('rechaza una tarifa no positiva (sin cotización firme)', () => {
    const repo = new FakePromosRepository();
    const useCase = new ValidatePromoUseCase(repo);

    expect(() => useCase.execute('VEO20', 0)).toThrow(/noFare/);
    expect(repo.validate).not.toHaveBeenCalled();
  });
});
