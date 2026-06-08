/** Vista de un pago (lado conductor). Montos en céntimos PEN. */
export interface PaymentView {
  id: string;
  tripId: string;
  method: string;
  status: string;
  amountCents: number;
  grossCents: number;
  commissionCents: number;
  feeCents: number;
  externalRef: string | null;
}
