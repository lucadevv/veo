import type { MobileDigitalPaymentMethod, PaymentView } from '@veo/api-client';

/**
 * Payment de LIQUIDACIÓN de la deuda de comisiones del conductor (kind=DEBT_SETTLEMENT, ADR-022 §P-A). Mismo
 * shape que un cobro del pasajero: `amountCents` = deuda total pendiente; el checkout (deepLink/QR/urlPay/CIP)
 * está presente mientras `status` sea PENDING (ProntoPaga) y ausente si capturó de una (sandbox/live).
 */
export type DebtSettlement = PaymentView;

/**
 * Método DIGITAL con el que el conductor salda su deuda. Es el subconjunto digital del contrato — CASH NO
 * aplica (el efectivo se salda con el pasajero presente, no una deuda acumulada; el BFF lo rechaza con 400).
 */
export type DebtSettleMethod = MobileDigitalPaymentMethod;

/** Contrato del repositorio de saldar deuda (capa domain). Implementación concreta en `data/`. */
export interface DebtRepository {
  /**
   * POST /earnings/debt/settle — inicia (o RECUPERA, idempotente) el cobro de liquidación de la deuda de
   * comisiones por un medio DIGITAL. Devuelve el Payment con su checkout, o ya CAPTURED (sandbox). Re-llamar
   * con la MISMA deuda pendiente devuelve el MISMO Payment (idempotencia aguas abajo por dedupKey). CASH → 400;
   * sin deuda pendiente → 409.
   */
  settle(method: DebtSettleMethod, payerRef?: string): Promise<DebtSettlement>;
}
