/**
 * Políticas puras del dominio de pagos (sin I/O, sin DB). Testeables como unidades.
 * Aquí viven: cálculo de comisión (BR-P04), la máquina de estados del pago, el backoff de
 * reintentos (BR-P02) y la derivación determinista de la dedupKey del cobro por viaje.
 */
import { addMoney, commission, money, subtractMoney, InvalidStateError } from '@veo/utils';
import type { PaymentStatus } from '@veo/shared-types';

/**
 * MODO del cobro (F2.7 · ADR-017 §1.6 / ADR-015 §11.2 · nudo legal). Union TIPADA — jamás un string suelto.
 * Determina la TASA de comisión: `ON_DEMAND` usa la tasa configurable; `CARPOOLING` es 0 FIJO (ver
 * CARPOOLING_COMMISSION_BPS). El modo se determina en el PUNTO DE ENTRADA del cobro en payment-service (NO se
 * enriquecen los contratos de eventos cross-service): trip.completed → ON_DEMAND; charge service-rail → CARPOOLING.
 */
export const ChargeMode = {
  ON_DEMAND: 'ON_DEMAND',
  CARPOOLING: 'CARPOOLING',
} as const;
export type ChargeMode = (typeof ChargeMode)[keyof typeof ChargeMode];

/**
 * Tope de basis points de una tasa (100% = 10000 bps). La tasa de comisión se persiste y se transporta como
 * Int en bps (0..BPS_DENOMINATOR), NUNCA como float — y se divide por esto SOLO al aplicar (redondeo a céntimo
 * Int en `commission()`). Un único punto define el denominador (cero literales 10000 regados por el código).
 */
export const BPS_DENOMINATOR = 10_000;

/**
 * NUDO LEGAL (ADR-015 §11.2): la comisión del CARPOOLING es 0 FIJO. Es cost-sharing — cobrar comisión sobre un
 * viaje COMPARTIDO sería lucro de la plataforma, ILEGAL hasta el visto bueno legal. NO es admin-editable: la
 * resolución por modo devuelve SIEMPRE 0 para CARPOOLING; no hay fila en commission_config para él. Subirla
 * requiere un ADR + un flag legal explícito, JAMÁS un PUT del admin. Constante de dominio, cero strings mágicos.
 */
export const CARPOOLING_COMMISSION_BPS = 0;

/** Convierte una tasa en basis points Int (0..10000) a la fracción 0..1 que consume `commission()`. Solo se
 * aplica al COBRAR; el valor de dominio/persistido es SIEMPRE el Int en bps. */
export function bpsToRate(bps: number): number {
  if (!Number.isInteger(bps) || bps < 0 || bps > BPS_DENOMINATOR) {
    throw new InvalidStateError(`tasa en bps inválida: ${bps} (esperado un entero 0..${BPS_DENOMINATOR})`);
  }
  return bps / BPS_DENOMINATOR;
}

/**
 * Resuelve la tasa de comisión (en bps Int) para un MODO de cobro (F2.7). CARPOOLING → 0 SIEMPRE (legal-gated,
 * constante de dominio). ON_DEMAND → la tasa configurada que provee el caller (la `CommissionConfig`, con su
 * propia degradación honesta al env). Pura y testeable: el guard legal del carpooling vive ACÁ, un único punto.
 */
export function resolveCommissionBps(mode: ChargeMode, onDemandRateBps: number): number {
  return mode === ChargeMode.CARPOOLING ? CARPOOLING_COMMISSION_BPS : onDemandRateBps;
}

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

/**
 * F3c-payment · PREFIJO TIPADO de la dedupKey de un refund SYSTEM-INITIATED por `booking.cancelled` (cero
 * strings mágicos: la derivación de la dedupKey deriva de esta constante única). Distingue los refunds
 * AUTOMÁTICOS (con marcador system-initiated) de los ADMIN discrecionales (dedupKey NULL): el admin correlaciona
 * un Refund REJECTED system-initiated a su booking por este prefijo para disparar el refund admin manual (backstop).
 */
export const BOOKING_CANCEL_REFUND_DEDUP_PREFIX = 'booking-cancel-refund:' as const;

/**
 * F3c-payment · Clave de idempotencia DETERMINISTA del refund SYSTEM-INITIATED por `booking.cancelled`
 * (ADR-014 §6 camino infeliz). Persiste en `Refund.dedupKey`. El UNIQUE es PARCIAL (status <> REJECTED, en SQL):
 * un `booking.cancelled` duplicado/reordenado (Kafka at-least-once) cuyo refund previo sigue ACTIVO choca →
 * P2002 → no-op graceful (NO doble plata). Si el refund previo quedó REJECTED (proveedor rechazó), la key ya no
 * bloquea (el marcador durable usa status REJECTED, fuera del índice). En carpooling `tripId = bookingId`
 * (UUID opaco · §5.5): un Payment ⇄ un bookingId ⇄ un refund de cancelación vivo. Mismo bookingId → misma key.
 */
export function deriveBookingCancellationRefundDedupKey(bookingId: string): string {
  return `${BOOKING_CANCEL_REFUND_DEDUP_PREFIX}${bookingId}`;
}
