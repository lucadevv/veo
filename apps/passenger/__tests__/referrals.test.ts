import type {ReferralSummary} from '@veo/api-client';
import {normalizeReferralCode} from '../src/features/referrals/domain/entities';
import type {ReferralsRepository} from '../src/features/referrals/domain/referralsRepository';
import {
  ReferralCodeError,
  RedeemReferralUseCase,
} from '../src/features/referrals/domain/usecases';

class FakeReferralsRepository implements ReferralsRepository {
  getSummary = jest.fn(
    async (): Promise<ReferralSummary> => ({
      code: 'MINE123',
      referredCount: 2,
      rewardsEarnedCents: 1000,
    }),
  );
  redeem = jest.fn(
    async (_code: string): Promise<ReferralSummary> => ({
      code: 'MINE123',
      referredCount: 3,
      rewardsEarnedCents: 1500,
    }),
  );
}

describe('normalizeReferralCode', () => {
  it('recorta, quita espacios y pasa a mayúsculas', () => {
    expect(normalizeReferralCode('  fr ie nd ')).toBe('FRIEND');
  });
});

describe('RedeemReferralUseCase', () => {
  it('normaliza el código y canjea cuando es válido', async () => {
    const repo = new FakeReferralsRepository();
    const useCase = new RedeemReferralUseCase(repo);

    await useCase.execute('  friend99 ');

    expect(repo.redeem).toHaveBeenCalledWith('FRIEND99');
  });

  it('rechaza un código vacío', () => {
    const repo = new FakeReferralsRepository();
    const useCase = new RedeemReferralUseCase(repo);

    expect(() => useCase.execute('   ')).toThrow(ReferralCodeError);
    expect(repo.redeem).not.toHaveBeenCalled();
  });

  it('rechaza un código demasiado corto', () => {
    const repo = new FakeReferralsRepository();
    const useCase = new RedeemReferralUseCase(repo);

    expect(() => useCase.execute('AB')).toThrow(/tooShort/);
  });

  it('rechaza el código propio (comparando normalizado)', () => {
    const repo = new FakeReferralsRepository();
    const useCase = new RedeemReferralUseCase(repo);

    expect(() => useCase.execute(' mine123 ', 'MINE123')).toThrow(/ownCode/);
    expect(repo.redeem).not.toHaveBeenCalled();
  });
});
