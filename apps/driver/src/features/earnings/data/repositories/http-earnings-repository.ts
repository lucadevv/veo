import type { HttpClient } from '@veo/api-client';
import { driverEarningsSummary, earningsSummary } from '@veo/api-client';
import type { EarningsBreakdown, EarningsOverview, EarningsRepository } from '../../domain';

/** Implementación HTTP del `EarningsRepository` contra el driver-bff. */
export class HttpEarningsRepository implements EarningsRepository {
  constructor(private readonly http: HttpClient) {}

  getSummary(): Promise<EarningsOverview> {
    return this.http.get('/earnings/summary', { schema: earningsSummary });
  }

  getBreakdown(): Promise<EarningsBreakdown> {
    return this.http.get('/earnings/breakdown', { schema: driverEarningsSummary });
  }
}
