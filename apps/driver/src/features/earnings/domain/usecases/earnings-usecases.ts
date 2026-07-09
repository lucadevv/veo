import type { EarningsRepository } from '../repositories/earnings-repository';
import type { EarningsBreakdown, EarningsDailySeries, EarningsOverview } from '../entities';

/** Caso de uso: resumen agregado de ganancias del conductor (incluye sus payouts). */
export class GetEarningsSummaryUseCase {
  constructor(private readonly earnings: EarningsRepository) {}

  execute(): Promise<EarningsOverview> {
    return this.earnings.getSummary();
  }
}

/** Caso de uso: desglose de ganancias (HOY/SEMANA/MES) del conductor. */
export class GetEarningsBreakdownUseCase {
  constructor(private readonly earnings: EarningsRepository) {}

  execute(): Promise<EarningsBreakdown> {
    return this.earnings.getBreakdown();
  }
}

/** Caso de uso: serie diaria de la semana en curso (bar chart "Por día"). */
export class GetEarningsDailyUseCase {
  constructor(private readonly earnings: EarningsRepository) {}

  execute(): Promise<EarningsDailySeries> {
    return this.earnings.getDaily();
  }
}
