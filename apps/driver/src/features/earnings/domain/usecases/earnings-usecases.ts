import type {EarningsRepository} from '../repositories/earnings-repository';
import type {EarningsBreakdown, EarningsOverview, PayoutList} from '../entities';

/** Caso de uso: resumen agregado de ganancias del conductor (incluye sus payouts). */
export class GetEarningsSummaryUseCase {
  constructor(private readonly earnings: EarningsRepository) {}

  execute(): Promise<EarningsOverview> {
    return this.earnings.getSummary();
  }
}

/** Caso de uso: lista de liquidaciones (payouts) del conductor. */
export class ListPayoutsUseCase {
  constructor(private readonly earnings: EarningsRepository) {}

  execute(): Promise<PayoutList> {
    return this.earnings.listPayouts();
  }
}

/** Caso de uso: desglose de ganancias (HOY/SEMANA) del conductor. */
export class GetEarningsBreakdownUseCase {
  constructor(private readonly earnings: EarningsRepository) {}

  execute(): Promise<EarningsBreakdown> {
    return this.earnings.getBreakdown();
  }
}
