import {
  type AddTipRequest,
  type CashConfirmRequest,
  type ChargeRequest,
  type DebtView,
  type MobileDigitalPaymentMethod,
  type PaymentView,
  type UserCreditView,
} from '@veo/api-client';

/**
 * TIPO del método DIGITAL elegible al cambiar un pago pendiente (TASK 3). Efectivo queda fuera: un cobro
 * digital pendiente no se "cambia a efectivo" (el server responde 422). Es el enum de CONTRATO del wire
 * (`@veo/api-client` · `mobileDigitalPaymentMethod`); la app NO duplica el array de opciones: la LISTA
 * que se renderiza se deriva de la fuente canónica única `PAYMENT_METHODS` (ver `DIGITAL_PAYMENT_METHODS`
 * en `presentation/stores/paymentPrefsStore`). El BFF sigue validando el contrato (422 ante CASH).
 */
export type ChangeablePaymentMethod = MobileDigitalPaymentMethod;

/** Abstracción del repositorio de Pagos del pasajero (DIP). Montos en céntimos PEN. */
export interface PaymentsRepository {
  /** POST /payments/charge → cobra el viaje (Yape/Plin/Cash/Card). */
  charge(input: ChargeRequest): Promise<PaymentView>;
  /** GET /payments/:id → estado del pago. */
  getPayment(paymentId: string): Promise<PaymentView>;
  /**
   * GET /payments/debts → deudas pendientes del pasajero (cobros en DEBT). Resume `hasDebt`/`totalCents`
   * y lista las deudas (más antigua → más nueva) para la franja del home y el sheet de deuda.
   */
  getMyDebts(): Promise<DebtView>;
  /**
   * GET /payments/credit → saldo de crédito GASTABLE del pasajero (redención de referidos · Ola 2A). El
   * cobro lo aplica solo; esto es para MOSTRAR el saldo. El BFF usa el userId del JWT (anti-IDOR).
   */
  getUserCredit(): Promise<UserCreditView>;
  /**
   * POST /payments/:id/retry-charge → re-cobra un cobro en DEBT (saldar deuda, BR-P02). Devuelve el
   * `PaymentView`: CAPTURED si saldó directo, o PENDING con checkout (ProntoPaga) si requiere completar
   * el pago fuera de banda. El BFF responde 404 si el cobro no es del pasajero (anti-IDOR/enumeración).
   */
  retryCharge(paymentId: string): Promise<PaymentView>;
  /**
   * GET /payments/by-trip/:tripId → cobro CANÓNICO del viaje (auto-cobrado al completar). Devuelve
   * `null` si aún no existe (404: el consumer puede demorar) para que la presentación reintente sin
   * tratarlo como error duro. El BFF también responde 404 ante un viaje ajeno (anti-IDOR).
   */
  getPaymentByTrip(tripId: string): Promise<PaymentView | null>;
  /** POST /payments/:id/cash/confirm → confirma el pago en efectivo. */
  confirmCash(paymentId: string, input: CashConfirmRequest): Promise<PaymentView>;
  /**
   * POST /payments/:id/method → cambia el método de un pago PENDIENTE a otro DIGITAL (TASK 3). Devuelve
   * el `PaymentView` con el checkout NUEVO del método elegido (deepLink/QR/CIP/web), y el llamador sigue
   * el poll a CAPTURED. El BFF responde 422 si el método es CASH (no aplica) y 409 si el pago ya no es
   * cambiable (capturó/venció/cambió de estado); el repo los traduce a errores de dominio tipados.
   */
  changePaymentMethod(
    paymentId: string,
    method: ChangeablePaymentMethod,
  ): Promise<PaymentView>;
  /** POST /trips/:id/tip → deja propina al conductor (100% al conductor; idempotente en el bff). */
  addTip(tripId: string, input: AddTipRequest): Promise<PaymentView>;
}
