import type { HttpClient } from '@veo/api-client';
import { settleDriverDebtRequest, settleDriverDebtView } from '@veo/api-client';
import type { DebtRepository, DebtSettleMethod, DebtSettlement } from '../../domain';

/** Implementación HTTP del `DebtRepository` contra el driver-bff. */
export class HttpDebtRepository implements DebtRepository {
  constructor(private readonly http: HttpClient) {}

  settle(method: DebtSettleMethod, payerRef?: string): Promise<DebtSettlement> {
    // Validamos el body con el contrato SOBERANO (`settleDriverDebtRequest`) antes de salir a la red: SOLO
    // método digital (el BFF rechaza CASH con 400). El `driverId` NO viaja: lo pone el BFF desde la identidad.
    const body = settleDriverDebtRequest.parse({ method, payerRef });
    return this.http.post('/earnings/debt/settle', { body, schema: settleDriverDebtView });
  }
}
