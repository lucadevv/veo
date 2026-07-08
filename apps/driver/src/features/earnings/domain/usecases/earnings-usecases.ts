import type { EarningsRepository } from '../repositories/earnings-repository';
import type { EarningsBreakdown, EarningsOverview } from '../entities';

/** Caso de uso: resumen agregado de ganancias del conductor (incluye sus payouts). */
export class GetEarningsSummaryUseCase {
  constructor(private readonly earnings: EarningsRepository) {}

  execute(): Promise<EarningsOverview> {
    return this.earnings.getSummary();
  }
}

/** Caso de uso: desglose de ganancias (HOY/SEMANA) del conductor. */
export class GetEarningsBreakdownUseCase {
  constructor(private readonly earnings: EarningsRepository) {}

  execute(): Promise<EarningsBreakdown> {
    return this.earnings.getBreakdown();
  }
}
