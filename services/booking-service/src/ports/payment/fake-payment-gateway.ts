/**
 * FakePaymentGateway — implementación DETERMINÍSTICA del puerto PaymentGateway para los tests del dominio
 * (sin red, sin DI de Nest). Respeta el MISMO contrato que los adapters REST/gRPC reales. Configurable por
 * constructor para ejercitar los caminos felices E INFELICES (deudor, payment caído/timeout, charge).
 *
 * NO vive bajo *.spec.ts a propósito: es test-support reusable por varios specs (gate de deuda, F3b charge).
 */
import {
  PaymentStatus,
  type ChargeInput,
  type ChargeResult,
  type DebtSummary,
  type PaymentGateway,
  type PaymentView,
} from './payment-gateway.port';

export interface FakePaymentGatewayOptions {
  /** Resumen de deuda que devuelve getDebt. Default: sin deuda. */
  debt?: DebtSummary;
  /** Si se setea, getDebt LANZA este error (simula payment caído/timeout). */
  debtError?: Error;
  /** Si se setea, charge LANZA este error. */
  chargeError?: Error;
  /** Resultado del charge. Default: PENDING con un paymentId fijo. */
  chargeResult?: ChargeResult;
  /** Vista que devuelve getPayment. Default: found=false. */
  payment?: PaymentView;
}

const NO_DEBT: DebtSummary = { hasDebt: false, totalCents: 0, items: [] };

const DEFAULT_CHARGE: ChargeResult = {
  paymentId: '00000000-0000-0000-0000-0000000000f1',
  status: PaymentStatus.PENDING,
};

const NOT_FOUND_PAYMENT: PaymentView = {
  id: '',
  tripId: '',
  method: '',
  status: '',
  grossCents: 0,
  amountCents: 0,
  failureReason: '',
  found: false,
};

export class FakePaymentGateway implements PaymentGateway {
  /** Llamadas registradas para aserciones (orden e inputs). */
  readonly chargeCalls: ChargeInput[] = [];
  readonly debtCalls: string[] = [];
  readonly getPaymentCalls: string[] = [];

  constructor(private readonly opts: FakePaymentGatewayOptions = {}) {}

  charge(input: ChargeInput): Promise<ChargeResult> {
    this.chargeCalls.push(input);
    if (this.opts.chargeError) return Promise.reject(this.opts.chargeError);
    return Promise.resolve(this.opts.chargeResult ?? DEFAULT_CHARGE);
  }

  getDebt(passengerId: string): Promise<DebtSummary> {
    this.debtCalls.push(passengerId);
    if (this.opts.debtError) return Promise.reject(this.opts.debtError);
    return Promise.resolve(this.opts.debt ?? NO_DEBT);
  }

  getPayment(paymentId: string): Promise<PaymentView> {
    this.getPaymentCalls.push(paymentId);
    return Promise.resolve(this.opts.payment ?? NOT_FOUND_PAYMENT);
  }
}
