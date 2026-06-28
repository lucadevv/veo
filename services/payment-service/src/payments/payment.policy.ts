/**
 * Políticas puras del dominio de pagos (sin I/O, sin DB). Testeables como unidades.
 * Aquí viven: cálculo de comisión (BR-P04), la máquina de estados del pago, el backoff de
 * reintentos (BR-P02) y la derivación determinista de la dedupKey del cobro por viaje.
 */
import { addMoney, commission, money, subtractMoney, InvalidStateError } from '@veo/utils';
import type { PaymentStatus } from '@veo/shared-types';

/**
 * MODO del cobro (F2.7 · ADR-017 §1.6 / ADR-015 §11.2). Union TIPADA — jamás un string suelto. Determina QUÉ
 * tasa se aplica Y CÓMO (dos MODELOS de dinero distintos, ver `computeChargeAmounts`):
 *  - `ON_DEMAND` (inDrive): la comisión se DESCUENTA del conductor. El pasajero paga la tarifa; el conductor
 *    recibe tarifa − comisión; la plataforma retiene la comisión. Tasa = `onDemandRateBps` (admin-editable).
 *  - `CARPOOLING` (BlaBlaCar cost-sharing): la comisión es un SERVICE FEE que paga el PASAJERO, SUMADO arriba.
 *    El conductor cobra el 100% de su contribución; el pasajero paga contribución + fee. Tasa = `carpoolingFeeBps`
 *    (admin-editable: NO hay nudo legal — el fee es del pasajero, NO lucro sobre el conductor en cost-sharing).
 * El modo se determina en el PUNTO DE ENTRADA del cobro en payment-service (NO se enriquecen los contratos de
 * eventos cross-service): trip.completed → ON_DEMAND; charge service-rail → CARPOOLING.
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

/** Convierte una tasa en basis points Int (0..10000) a la fracción 0..1 que consume `commission()`. Solo se
 * aplica al COBRAR; el valor de dominio/persistido es SIEMPRE el Int en bps. */
export function bpsToRate(bps: number): number {
  if (!Number.isInteger(bps) || bps < 0 || bps > BPS_DENOMINATOR) {
    throw new InvalidStateError(`tasa en bps inválida: ${bps} (esperado un entero 0..${BPS_DENOMINATOR})`);
  }
  return bps / BPS_DENOMINATOR;
}

/**
 * Las DOS tasas editables de la comisión de plataforma (bps Int 0..10000). Cada MODO usa la suya — NUNCA float.
 */
export interface CommissionRatesBps {
  /** ON_DEMAND: comisión DESCONTADA al conductor (inDrive). */
  onDemandRateBps: number;
  /** CARPOOLING: service fee SUMADO al pasajero (BlaBlaCar cost-sharing). */
  carpoolingFeeBps: number;
}

/**
 * Resuelve la tasa de comisión (en bps Int) para un MODO de cobro (F2.7). CARPOOLING → `carpoolingFeeBps`;
 * ON_DEMAND → `onDemandRateBps`. Ambas admin-editables (la `CommissionConfig`, con su propia degradación honesta:
 * on-demand cae al env, carpooling cae a 0). Pura y testeable: el único punto de resolución por modo.
 */
export function resolveCommissionBps(mode: ChargeMode, rates: CommissionRatesBps): number {
  return mode === ChargeMode.CARPOOLING ? rates.carpoolingFeeBps : rates.onDemandRateBps;
}

export interface ChargeAmounts {
  /**
   * Bruto COBRADO al pasajero (base del recibo), incluye surge, EXCLUYE propina. ⚠️ La semántica DIFIERE por modo:
   *  - ON_DEMAND: = la TARIFA (el `inputCents`). La comisión se DESCUENTA de acá → el conductor recibe bruto − comisión.
   *  - CARPOOLING: = contribución + serviceFee (el fee se SUMA arriba). El conductor NO recibe esto: recibe su
   *    contribución FULL; el bruto cobrado al pasajero es contribución + fee. Acá el bruto NO es el `inputCents`.
   * Persistido en `Payment.grossCents` (= lo cobrado al pasajero, en ambos modos). El neto del conductor es
   * SIEMPRE derivable como `grossCents − commissionCents + tipCents` (vale para ambos modos · ver `driverNetCents`).
   */
  grossCents: number;
  /**
   * Descuento de promoción aplicado al pasajero (Ola 2A). Reduce SOLO lo que paga el pasajero (`amountCents`);
   * NUNCA la comisión/fee ni el neto del conductor (la plataforma asume el costo de la promo). Topado al bruto.
   */
  discountCents: number;
  /** Propina: 100% al conductor, fuera de comisión/fee. */
  tipCents: number;
  /** Total cobrado al método de pago del pasajero = bruto − descuento + propina (en ambos modos). */
  amountCents: number;
  /**
   * Corte de la plataforma. ON_DEMAND: comisión = round(bruto × rate), DESCONTADA al conductor. CARPOOLING:
   * serviceFee = round(contribución × rate), que PAGA el pasajero (SUMADO al bruto). NO afectado por la promo.
   */
  commissionCents: number;
  /** Cargo visible al usuario (= comisión on-demand / service fee carpooling). */
  feeCents: number;
  /**
   * Neto del conductor por este cobro. ON_DEMAND: (bruto − comisión) + propina. CARPOOLING: contribución +
   * propina (el 100% de su contribución — la plataforma NO le descuenta nada). NO afectado por la promo.
   */
  driverNetCents: number;
}

/**
 * Calcula los montos de un cobro por MODO (BR-P04 · F2.7 · camino de DINERO). El descuento de promoción
 * (opcional) reduce únicamente el total que paga el pasajero (`amountCents`), nunca la comisión/fee ni la
 * propina; se topa al bruto. `inputCents` cambia de SIGNIFICADO según el modo (ver cada modelo):
 *  - ON_DEMAND: `inputCents` = la TARIFA cobrada al pasajero. La comisión se le DESCUENTA al conductor.
 *  - CARPOOLING: `inputCents` = la CONTRIBUCIÓN del conductor (cost-sharing). El service fee se SUMA arriba; el
 *    pasajero paga contribución + fee; el conductor cobra la contribución FULL.
 */
export function computeChargeAmounts(
  mode: ChargeMode,
  inputCents: number,
  tipCents: number,
  rate: number,
  discountCents = 0,
): ChargeAmounts {
  if (!Number.isInteger(inputCents) || inputCents < 0) {
    throw new InvalidStateError('inputCents debe ser un entero de céntimos no negativo');
  }
  if (!Number.isInteger(tipCents) || tipCents < 0) {
    throw new InvalidStateError('tipCents debe ser un entero de céntimos no negativo');
  }
  if (!Number.isInteger(discountCents) || discountCents < 0) {
    throw new InvalidStateError('discountCents debe ser un entero de céntimos no negativo');
  }
  return mode === ChargeMode.CARPOOLING
    ? carpoolingAmounts(inputCents, tipCents, rate, discountCents)
    : onDemandAmounts(inputCents, tipCents, rate, discountCents);
}

/**
 * ON_DEMAND (inDrive): la comisión se DESCUENTA del conductor. El pasajero paga la tarifa (`grossCents`); el
 * conductor recibe tarifa − comisión + propina; la plataforma retiene la comisión.
 */
function onDemandAmounts(
  grossCents: number,
  tipCents: number,
  rate: number,
  discountCents: number,
): ChargeAmounts {
  const appliedDiscount = Math.min(discountCents, grossCents);
  const gross = money(grossCents);
  const tip = money(tipCents);
  const commissionMoney = commission(gross, rate);
  const amount = addMoney(subtractMoney(gross, money(appliedDiscount)), tip);
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

/**
 * CARPOOLING (BlaBlaCar cost-sharing): el service fee es un cargo que paga el PASAJERO, SUMADO arriba de la
 * contribución. El conductor cobra el 100% de su contribución (la plataforma NO le descuenta nada); el pasajero
 * paga contribución + fee. ⚠️ El `grossCents` COBRADO ≠ el `contributionCents` de input: es contribución + fee.
 *  - serviceFee = round(contribución × rate)
 *  - grossCents (cobrado al pasajero, persistido) = contribución + serviceFee
 *  - commissionCents = serviceFee (el corte de la plataforma)
 *  - driverNetCents = contribución + propina (el conductor cobra FULL)
 */
function carpoolingAmounts(
  contributionCents: number,
  tipCents: number,
  rate: number,
  discountCents: number,
): ChargeAmounts {
  const contribution = money(contributionCents);
  const tip = money(tipCents);
  const serviceFee = commission(contribution, rate); // round(contribución × rate) → céntimo Int
  const gross = addMoney(contribution, serviceFee); // BRUTO cobrado al pasajero = contribución + fee
  const appliedDiscount = Math.min(discountCents, gross.cents);
  const amount = addMoney(subtractMoney(gross, money(appliedDiscount)), tip);
  const driverNet = addMoney(contribution, tip); // contribución FULL + propina (NO se descuenta el fee)
  return {
    grossCents: gross.cents,
    discountCents: appliedDiscount,
    tipCents,
    amountCents: amount.cents,
    commissionCents: serviceFee.cents,
    feeCents: serviceFee.cents,
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

/**
 * PREFIJO TIPADO de la dedupKey de un refund ADMIN discrecional cuando el operador trae un `Idempotency-Key`
 * (cero strings mágicos). Distingue el namespace del refund admin del system-initiated (`booking-cancel-refund:`)
 * para que NUNCA colisionen en `Refund.dedupKey` aunque el UUID del cliente coincidiera con un bookingId.
 */
export const ADMIN_REFUND_DEDUP_PREFIX = 'admin-refund:' as const;

/**
 * Clave de idempotencia de un refund ADMIN discrecional, derivada del `Idempotency-Key` que el operador envía
 * desde el panel. Persiste en `Refund.dedupKey` (UNIQUE PARCIAL en SQL, status <> REJECTED): un doble-submit o
 * un reintento de red con el MISMO key choca → P2002 → el caller devuelve el refund existente (NO doble plata).
 * El refund PARCIAL no lo blinda la máquina de estados (el CAS solo impide exceder el saldo, no hace idempotente
 * la operación lógica), así que esta key es la barrera real. Sin `Idempotency-Key` ⇒ dedupKey NULL (como antes).
 */
export function deriveAdminRefundDedupKey(idempotencyKey: string): string {
  return `${ADMIN_REFUND_DEDUP_PREFIX}${idempotencyKey}`;
}
