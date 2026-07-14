import type {
  ChargeRequest,
  DebtView,
  PaymentView,
  UserCreditView,
} from '@veo/api-client';
import {uuidv4} from '../../../shared/utils/uuid';
import type {
  ChangeablePaymentMethod,
  PaymentsRepository,
} from './paymentsRepository';

/** Tope razonable de propina (S/ 200) para evitar dedazos catastróficos. */
export const MAX_TIP_CENTS = 20_000;

/** Error de validación de propina. */
export class TipValidationError extends Error {
  constructor() {
    super('La propina debe estar entre S/ 0.01 y S/ 200.00');
    this.name = 'TipValidationError';
  }
}

/**
 * Convierte un monto en soles (texto que escribe el usuario, p. ej. "5" o "5,50") a céntimos PEN.
 * Acepta coma o punto decimal. Devuelve 0 si el texto no es un número positivo (puro, testeable).
 */
export function parseTipToCents(input: string): number {
  const parsed = Number.parseFloat(input.replace(',', '.'));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.round(parsed * 100);
}

/**
 * Cobra el viaje (Yape/Plin/Cash/Card). Añade un `dedupKey` de idempotencia si el llamador no lo
 * proporciona, para que reintentos por red no dupliquen el cargo (BR-P01).
 */
export class ChargeTripUseCase {
  constructor(private readonly repository: PaymentsRepository) {}

  execute(input: ChargeRequest): Promise<PaymentView> {
    return this.repository.charge({
      ...input,
      dedupKey: input.dedupKey ?? uuidv4(),
    });
  }
}

/**
 * Recibo CANÓNICO del cobro de un viaje (`GET /payments/by-trip/:tripId`). El cobro se auto-genera al
 * completar el viaje (consumer Kafka), así que puede aún no existir: devuelve `null` (404) en vez de
 * lanzar, para que la presentación reintente con un poll suave mientras "procesa".
 */
export class GetPaymentByTripUseCase {
  constructor(private readonly repository: PaymentsRepository) {}

  execute(tripId: string): Promise<PaymentView | null> {
    return this.repository.getPaymentByTrip(tripId);
  }
}

/**
 * Estado de un cobro por su id (`GET /payments/:id`). Lo usa el poll del sheet de deuda: tras saldar con
 * checkout (ProntoPaga), espera a que el cobro pase a CAPTURED por el webhook. Sin lógica (refleja el id).
 */
export class GetPaymentUseCase {
  constructor(private readonly repository: PaymentsRepository) {}

  execute(paymentId: string): Promise<PaymentView> {
    return this.repository.getPayment(paymentId);
  }
}

/** Confirma el pago en efectivo del viaje (BR-P03). */
export class ConfirmCashUseCase {
  constructor(private readonly repository: PaymentsRepository) {}

  execute(paymentId: string): Promise<PaymentView> {
    return this.repository.confirmCash(paymentId, {confirmed: true});
  }
}

/**
 * Deja propina al conductor sobre un viaje ya cobrado (`POST /trips/:id/tip`, BR-P04: 100% al
 * conductor). Valida que el monto sea un entero positivo dentro del tope; la idempotencia la
 * garantiza el bff (deriva la dedupKey de passenger+trip+monto), así que reintentos no duplican.
 */
export class AddTipUseCase {
  constructor(private readonly repository: PaymentsRepository) {}

  execute(tripId: string, tipCents: number): Promise<PaymentView> {
    if (
      !Number.isInteger(tipCents) ||
      tipCents <= 0 ||
      tipCents > MAX_TIP_CENTS
    ) {
      throw new TipValidationError();
    }
    return this.repository.addTip(tripId, {tipCents});
  }
}

/**
 * Deudas pendientes del pasajero (`GET /payments/debts`, BR-P02). Las consume la franja del home (señal
 * pasiva) y el sheet de deuda al pedir bloqueado. Sin lógica: refleja el contrato server-side tal cual.
 */
export class GetMyDebtsUseCase {
  constructor(private readonly repository: PaymentsRepository) {}

  execute(): Promise<DebtView> {
    return this.repository.getMyDebts();
  }
}

/**
 * Saldo de crédito GASTABLE del pasajero (`GET /payments/credit` · redención de referidos · Ola 2A). Sin
 * lógica: el cobro aplica el crédito server-side (Lote B); esto solo lo expone para MOSTRARLO en la app.
 */
export class GetUserCreditUseCase {
  constructor(private readonly repository: PaymentsRepository) {}

  execute(): Promise<UserCreditView> {
    return this.repository.getUserCredit();
  }
}

/**
 * Salda una deuda re-cobrando un cobro en DEBT (`POST /payments/:id/retry-charge`, BR-P02). Devuelve el
 * `PaymentView` resultante: CAPTURED si saldó directo, o PENDING con checkout (ProntoPaga) a completar.
 * La idempotencia la garantiza el bff (deriva la dedupKey del cobro); el saldar es del lado del pasajero.
 */
export class RetryChargeUseCase {
  constructor(private readonly repository: PaymentsRepository) {}

  execute(paymentId: string): Promise<PaymentView> {
    return this.repository.retryCharge(paymentId);
  }
}

/**
 * Paga una PENALIDAD DE CANCELACIÓN pendiente (`POST /payments/penalties/:id/settle`, F2.3). Es el
 * camino de saldar de los ítems kind=CANCELLATION_PENALTY de `GET /payments/debts` (una penalidad NO es
 * un Payment: retry-charge no aplica). Devuelve el `PaymentView` del cobro de liquidación: CAPTURED si
 * saldó directo, o PENDING con checkout (ProntoPaga) a completar. Sin lógica extra: el anti-IDOR (404
 * ajena) y el 409 (perdonada/cobrada) los resuelve el server.
 */
export class SettlePenaltyUseCase {
  constructor(private readonly repository: PaymentsRepository) {}

  execute(
    penaltyId: string,
    method: ChangeablePaymentMethod,
  ): Promise<PaymentView> {
    return this.repository.settlePenalty(penaltyId, method);
  }
}

/**
 * El método pedido no aplica para cambiar un pago pendiente (422). En la práctica: CASH — un cobro
 * digital pendiente no se "cambia a efectivo". La UI ni siquiera ofrece efectivo en el selector de
 * cambio, así que este error es la red de seguridad de contrato (no un camino esperado del usuario).
 */
export class PaymentMethodNotApplicableError extends Error {
  constructor() {
    super('Ese método no se puede usar para este pago.');
    this.name = 'PaymentMethodNotApplicableError';
  }
}

/**
 * El pago ya NO es cambiable (409): capturó, venció o cambió de estado entre que la UI mostró el cambio
 * y el usuario lo pidió. La UI lo refleja honesto ("este pago ya no está pendiente") y vuelve a leer el
 * estado real en vez de insistir con un checkout muerto.
 */
export class PaymentNotChangeableError extends Error {
  constructor() {
    super('Este pago ya no se puede cambiar.');
    this.name = 'PaymentNotChangeableError';
  }
}

/**
 * Cambia el método de un pago PENDIENTE a otro DIGITAL (`POST /payments/:id/method`, TASK 3). Devuelve
 * el `PaymentView` con el checkout NUEVO del método elegido (deepLink/QR/CIP/web): el llamador re-renderiza
 * ese checkout y sigue el poll a CAPTURED. Errores de contrato (422 CASH / 409 no-cambiable) ya vienen
 * tipados del repo; el usecase no agrega lógica (refleja el id + método tal cual el server-side resuelve).
 */
export class ChangePaymentMethodUseCase {
  constructor(private readonly repository: PaymentsRepository) {}

  execute(
    paymentId: string,
    method: ChangeablePaymentMethod,
  ): Promise<PaymentView> {
    return this.repository.changePaymentMethod(paymentId, method);
  }
}
