/**
 * Políticas puras del dominio de pagos (sin I/O, sin DB). Testeables como unidades.
 * Aquí viven: cálculo de comisión (BR-P04), la máquina de estados del pago, el backoff de
 * reintentos (BR-P02) y la derivación determinista de la dedupKey del cobro por viaje.
 */
import { addMoney, commission, money, subtractMoney, InvalidStateError } from '@veo/utils';
import type { PaymentStatus } from '@veo/shared-types';

export interface ChargeAmounts {
  /** Ticket bruto: incluye surge, EXCLUYE propinas. Base de la comisión. */
  grossCents: number;
  /**
   * Descuento de promoción aplicado al pasajero (Ola 2A). Reduce SOLO lo que paga el pasajero;
   * la comisión se sigue calculando sobre el bruto (la plataforma asume el costo de la promo).
   */
  discountCents: number;
  /** Propina: 100% al conductor, fuera de comisión. */
  tipCents: number;
  /** Total cobrado al pasajero = bruto − descuento + propina. */
  amountCents: number;
  /** Comisión de plataforma = commission(bruto, rate) — NO afectada por la promo. */
  commissionCents: number;
  /** Comisión visible al usuario (= comisión de plataforma). */
  feeCents: number;
  /** Neto del conductor por este cobro = (bruto − comisión) + propina — NO afectado por la promo. */
  driverNetCents: number;
}

/**
 * Calcula los montos de un cobro (BR-P04). La comisión se aplica SOLO sobre el bruto; las propinas
 * se transfieren íntegras al conductor. El descuento de promoción (opcional) reduce únicamente el
 * total que paga el pasajero (`amountCents`), nunca la comisión ni la propina; se topa al bruto.
 */
export function computeChargeAmounts(
  grossCents: number,
  tipCents: number,
  rate: number,
  discountCents = 0,
): ChargeAmounts {
  if (!Number.isInteger(grossCents) || grossCents < 0) {
    throw new InvalidStateError('grossCents debe ser un entero de céntimos no negativo');
  }
  if (!Number.isInteger(tipCents) || tipCents < 0) {
    throw new InvalidStateError('tipCents debe ser un entero de céntimos no negativo');
  }
  if (!Number.isInteger(discountCents) || discountCents < 0) {
    throw new InvalidStateError('discountCents debe ser un entero de céntimos no negativo');
  }
  const appliedDiscount = Math.min(discountCents, grossCents);
  const gross = money(grossCents);
  const discount = money(appliedDiscount);
  const tip = money(tipCents);
  const commissionMoney = commission(gross, rate);
  const amount = addMoney(subtractMoney(gross, discount), tip);
  const driverNet = addMoney(subtractMoney(gross, commissionMoney), tip);
  return {
    grossCents,
    discountCents: appliedDiscount,
    tipCents,
    amountCents: amount.cents,
    commissionCents: commissionMoney.cents,
    feeCents: commissionMoney.cents,
    driverNetCents: driverNet.cents,
  };
}

/** Transiciones válidas de la máquina de estados del pago. */
const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  PENDING: ['CAPTURED', 'FAILED', 'DEBT'],
  // Una deuda puede saldarse después (reintento manual / nuevo cobro).
  DEBT: ['CAPTURED', 'FAILED'],
  // Un cobro fallido (transitorio) puede reintentarse y capturarse, o caer en deuda.
  FAILED: ['CAPTURED', 'DEBT'],
  // Un cobro capturado se reembolsa total (→REFUNDED) o parcial (→PARTIALLY_REFUNDED).
  CAPTURED: ['REFUNDED', 'PARTIALLY_REFUNDED'],
  // Un parcial admite más parciales (from===to) y completarse a total (→REFUNDED).
  PARTIALLY_REFUNDED: ['REFUNDED'],
  REFUNDED: [],
};

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  if (from === to) return true;
  return PAYMENT_TRANSITIONS[from].includes(to);
}

export function assertPaymentTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransitionPayment(from, to)) {
    throw new InvalidStateError(`Transición de pago inválida: ${from} → ${to}`);
  }
}

/**
 * Estados de pago a los que se les puede AÑADIR una propina (BR-P04). Una propina entra sobre
 * un cobro vivo: PENDING (efectivo aún sin confirmar, o digital en curso) o CAPTURED (ya cobrado).
 * No se admite sobre REFUNDED/FAILED/DEBT (cobro cerrado o sin liquidar).
 */
const TIPPABLE_STATUSES: readonly PaymentStatus[] = ['PENDING', 'CAPTURED'];

export function canAddTip(status: PaymentStatus): boolean {
  return TIPPABLE_STATUSES.includes(status);
}

export function assertCanAddTip(status: PaymentStatus): void {
  if (!canAddTip(status)) {
    throw new InvalidStateError(`No se puede añadir propina a un pago en estado ${status}`);
  }
}

/**
 * Backoff exponencial para los reintentos del riel (BR-P02): baseMs * 2^(attempt-1).
 * attempt es 1-based (1er reintento → baseMs).
 */
export function retryDelayMs(attempt: number, baseMs: number): number {
  if (attempt <= 1) return baseMs;
  return baseMs * 2 ** (attempt - 1);
}

/**
 * Clave de idempotencia determinista para el cobro que nace del evento trip.completed.
 * Reprocesar el evento no genera un segundo cobro (mismo dedupKey → choca contra el UNIQUE).
 */
export function deriveTripChargeDedupKey(tripId: string): string {
  return `trip-completed:${tripId}`;
}

/**
 * Clave de idempotencia del REVERSO contra el proveedor (INTEGRACIONES §4): derivada de la operación
 * de negocio (el Refund persistido ANTES de llamar al riel). Mismo refund → misma key.
 */
export function deriveRefundIdempotencyKey(refundId: string): string {
  return `refund-${refundId}`;
}
