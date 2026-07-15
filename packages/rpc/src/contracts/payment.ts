/**
 * Tipos wire de veo.payment.v1 (proto/payment.proto) — FUENTE ÚNICA para todos los consumidores.
 * Derivados a mano del .proto canónico con la semántica del loader de @veo/rpc
 * (keepCase:false → camelCase; defaults:true → proto3 entrega ""/0/false, nunca null).
 */

/** payment.GetPayment / GetPaymentByTrip / mensaje PaymentReply. */
export interface PaymentReply {
  id: string;
  tripId: string;
  method: string;
  status: string;
  amountCents: number;
  grossCents: number;
  commissionCents: number;
  feeCents: number;
  externalRef: string;
  found: boolean;
  tipCents: number;
  /** Checkout asíncrono (ProntoPaga): ""/0 cuando no aplica; el BFF los expone como nullable. */
  externalUid: string;
  checkoutUrl: string;
  /** data-URI (data:image/png;base64,...). */
  qrCode: string;
  deepLink: string;
  cip: string;
  /** ISO-8601; "" si no aplica. */
  checkoutExpiresAt: string;
  /** Razón estructurada del fallo del cobro; "" cuando no hubo fallo (el BFF la re-mapea a null). */
  failureReason: string;
}

/** payment.GetUserCredit / mensaje UserCreditReply (saldo de crédito GASTABLE del usuario · céntimos PEN). */
export interface UserCreditReply {
  balanceCents: number;
}

/**
 * payment.GetPendingCashByDriver / mensaje PendingCashReply — cobro CASH PENDING (kind=FARE) más reciente
 * del conductor que quedó sin confirmar (force-close post-viaje). `found=false` ⇒ no tiene ninguno
 * (proto3 sin presence: tripId="" / amountCents=0 cuando found=false).
 */
export interface PendingCashReply {
  found: boolean;
  tripId: string;
  amountCents: number;
}
