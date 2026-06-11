/**
 * Contratos downstream del dominio de pagos del public-bff. FUENTE ÚNICA dentro del BFF:
 * payments.service (proxy GET /payments/debt) y trips.service (gate de deuda al pedir viaje)
 * importan de aquí en vez de redeclarar el reply a mano.
 */

/** Forma del resumen accionable que devuelve payment-service GET /payments/debt. */
export interface DebtSummaryReply {
  hasDebt: boolean;
  debts: {
    /** id del Payment (DEBT/PENDING_ACTION). Ausente en CANCELLATION_PENALTY. */
    paymentId?: string;
    /** id de la CancellationPenalty (kind=CANCELLATION_PENALTY). */
    penaltyId?: string;
    tripId: string;
    amountCents: number;
    reason: string;
    createdAt: string;
    /** DEBT y CANCELLATION_PENALTY bloquean el gate; PENDING_ACTION (pago por completar) NO. */
    kind?: 'DEBT' | 'PENDING_ACTION' | 'CANCELLATION_PENALTY';
  }[];
  totalCents: number;
}
