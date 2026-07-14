import {
  type AddTipRequest,
  ApiError,
  type CashConfirmRequest,
  type ChargeRequest,
  type DebtView,
  debtView,
  type HttpClient,
  changePaymentMethodRequest,
  changePaymentMethodView,
  paymentByTripView,
  type PaymentView,
  paymentView,
  retryChargeView,
  settlePenaltyRequest,
  settlePenaltyView,
  type UserCreditView,
  userCreditView,
} from '@veo/api-client';
import type {
  ChangeablePaymentMethod,
  PaymentsRepository,
} from '../domain/paymentsRepository';
import {
  PaymentMethodNotApplicableError,
  PaymentNotChangeableError,
} from '../domain/usecases';

/**
 * Ruta de `POST /payments/:id/method`. Helper de TRANSPORTE (la ruta no es parte del contrato de wire del
 * `@veo/api-client`), relativa a `env.publicBffUrl` (que ya incluye `/api/v1`). `:id` se interpola.
 */
const changePaymentMethodPath = (paymentId: string): string =>
  `/payments/${paymentId}/method`;

/** Implementación de `PaymentsRepository` contra el public-bff. */
export class HttpPaymentsRepository implements PaymentsRepository {
  constructor(private readonly http: HttpClient) {}

  charge(input: ChargeRequest): Promise<PaymentView> {
    return this.http.post('/payments/charge', {
      body: input,
      schema: paymentView,
      idempotencyKey: input.dedupKey,
    });
  }

  getPayment(paymentId: string): Promise<PaymentView> {
    return this.http.get(`/payments/${paymentId}`, {schema: paymentView});
  }

  getMyDebts(): Promise<DebtView> {
    return this.http.get('/payments/debts', {schema: debtView});
  }

  getUserCredit(): Promise<UserCreditView> {
    return this.http.get('/payments/credit', {schema: userCreditView});
  }

  retryCharge(paymentId: string): Promise<PaymentView> {
    // El bff deriva la idempotencia del cobro (un Payment por viaje): NO mandamos dedupKey propia.
    return this.http.post(`/payments/${paymentId}/retry-charge`, {
      schema: retryChargeView,
    });
  }

  settlePenalty(
    penaltyId: string,
    method: ChangeablePaymentMethod,
  ): Promise<PaymentView> {
    // Validamos el body con el contrato SOBERANO (`settlePenaltyRequest`) antes de salir a la red: SOLO
    // métodos digitales (CASH → 400 en el BFF; no hay conductor presente para confirmar efectivo).
    const body = settlePenaltyRequest.parse({method});
    return this.http.post(`/payments/penalties/${penaltyId}/settle`, {
      body,
      schema: settlePenaltyView,
    });
  }

  async getPaymentByTrip(tripId: string): Promise<PaymentView | null> {
    // El cobro se auto-genera al completar el viaje (consumer Kafka): puede demorar. Un 404 NO es un
    // error duro acá — significa "aún no existe" (o viaje ajeno, anti-IDOR). Lo normalizamos a `null`
    // para que la presentación reintente con un poll suave; el resto de errores se propagan.
    try {
      return await this.http.get(`/payments/by-trip/${tripId}`, {
        schema: paymentByTripView,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  confirmCash(
    paymentId: string,
    input: CashConfirmRequest,
  ): Promise<PaymentView> {
    return this.http.post(`/payments/${paymentId}/cash/confirm`, {
      body: input,
      schema: paymentView,
    });
  }

  addTip(tripId: string, input: AddTipRequest): Promise<PaymentView> {
    return this.http.post(`/trips/${tripId}/tip`, {
      body: input,
      schema: paymentView,
    });
  }

  async changePaymentMethod(
    paymentId: string,
    method: ChangeablePaymentMethod,
  ): Promise<PaymentView> {
    // Validamos el body con el contrato SOBERANO del `@veo/api-client` (`changePaymentMethodRequest`)
    // antes de salir a la red; la respuesta 200 usa `changePaymentMethodView` (= `paymentView`, trae el
    // checkout nuevo del método elegido).
    const body = changePaymentMethodRequest.parse({method});
    try {
      return await this.http.post(changePaymentMethodPath(paymentId), {
        body,
        schema: changePaymentMethodView,
      });
    } catch (err) {
      if (!(err instanceof ApiError)) {
        throw err;
      }
      // 422 → el método no aplica (CASH): un cobro digital pendiente no se "cambia a efectivo". La UI no
      // ofrece efectivo en el selector de cambio, así que esto es la red de seguridad de contrato.
      if (err.status === 422) {
        throw new PaymentMethodNotApplicableError();
      }
      // 409 → el pago ya no es cambiable (capturó/venció/cambió de estado): honesto, no insistir.
      if (err.status === 409) {
        throw new PaymentNotChangeableError();
      }
      throw err;
    }
  }
}
