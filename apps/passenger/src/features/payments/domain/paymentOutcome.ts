/**
 * Intérprete de DOMINIO del resultado de un `Payment` (la pregunta "¿en qué quedó este cobro?").
 *
 * Antes esta interpretación vivía TRIPLICADA en `DebtSheet` y re-implementada en `SettlementBody`
 * (status + método + checkout comparados a mano en 7 sitios de presentación): un `PaymentStatus`
 * nuevo significaba editar 7 ifs — y así fue como PARTIALLY_REFUNDED cayó al recibo "Pagado".
 * Ahora la pregunta vive ACÁ, una sola vez; la presentación hace switch EXHAUSTIVO sobre
 * `PaymentOutcome` (con `assertNever`) y solo elige UI.
 *
 * Sobre la normalización del wire (por qué método sí y status no):
 *  - `payment.status` YA es `PaymentStatus` (z.enum del contrato, en mayúsculas): el viejo
 *    `status.toUpperCase()` era cargo-cult y muere — el switch tipado obliga al compilador a
 *    exigir cada estado (incl. PARTIALLY_REFUNDED).
 *  - `payment.method` es `z.string()` LAXO en el contrato (no enum): la normalización a mayúsculas
 *    es legítima, pero se hace UNA vez acá (`isCashPayment`), no desparramada en cada componente.
 */
import type { MobilePaymentMethod, PaymentView } from '@veo/api-client';

/** Método efectivo, tipado contra el enum del contrato (cero strings mágicos en comparaciones). */
const CASH_METHOD: MobilePaymentMethod = 'CASH';

/**
 * Resultado de un cobro tal como la UI lo DISTINGUE hoy (ni un estado más — cero especulación):
 *  - `settled`: CAPTURED — el cobro quedó pagado (recibo / éxito).
 *  - `checkoutPending`: PENDING digital con checkout VIVO (ProntoPaga: `externalUid` + algún medio,
 *    espejo de cómo el server clasifica PENDING_ACTION) — el usuario debe completarlo fuera de banda
 *    (deepLink / web / QR / CIP) mientras el poll espera el webhook.
 *  - `processing`: PENDING digital SIN checkout vivo (sandbox / cobro en vuelo) — solo esperar (poll).
 *  - `cashPending`: PENDING en efectivo — falta la confirmación bilateral (BR-P03).
 *  - `debt`: DEBT — los reintentos se agotaron; `failureReason` es la razón ESTRUCTURADA del
 *    contrato (`method_unavailable:<METHOD>`, `declined`…), `null` si el backend no la informó.
 *  - `failed`: FAILED — el cobro falló terminal (estado honesto, nunca data falsa).
 *  - `refunded`: REFUNDED / PARTIALLY_REFUNDED — se devolvió plata (total o parcial según
 *    `partial`): NUNCA se celebra como "Pagado" (la lección de PARTIALLY_REFUNDED).
 */
export type PaymentOutcome =
  | { readonly kind: 'settled' }
  | { readonly kind: 'checkoutPending' }
  | { readonly kind: 'processing' }
  | { readonly kind: 'cashPending' }
  | { readonly kind: 'debt'; readonly failureReason: string | null }
  | { readonly kind: 'failed' }
  | { readonly kind: 'refunded'; readonly partial: boolean };

/**
 * ¿El pago trae instrucciones de checkout para completar el pago digital? (ProntoPaga). Cualquiera de
 * deepLink / checkoutUrl / qrCode / cip habilita la rama "Completa tu pago". Si TODOS son null/ausentes
 * (sandbox sin checkout), NO hay rama de checkout → el resultado cae a `processing`.
 */
export function hasCheckout(payment: PaymentView): boolean {
  return Boolean(payment.deepLink || payment.checkoutUrl || payment.qrCode || payment.cip);
}

/**
 * ¿El cobro es en efectivo? Normaliza el método UNA vez en el borde: `payment.method` viaja como
 * string laxo en el contrato (no enum), así que el wire podría mandar 'cash' en minúsculas.
 */
export function isCashPayment(payment: PaymentView): boolean {
  return payment.method.toUpperCase() === CASH_METHOD;
}

/** ¿El cobro quedó pagado (CAPTURED)? La pregunta de los polls: cortar cuando saldó. */
export function isPaymentSettled(payment: PaymentView): boolean {
  return interpretPaymentOutcome(payment).kind === 'settled';
}

/**
 * Interpreta el resultado de un `Payment` (la ÚNICA fuente de esta pregunta). Para PENDING decide
 * por método y checkout: efectivo → `cashPending` (el contrato garantiza que un cobro CASH nunca
 * trae checkout: esos campos son exclusivos del flujo digital fuera de banda); digital → con
 * checkout vivo `checkoutPending`, sin checkout `processing`.
 */
export function interpretPaymentOutcome(payment: PaymentView): PaymentOutcome {
  switch (payment.status) {
    case 'CAPTURED':
      return { kind: 'settled' };
    case 'PENDING':
      if (isCashPayment(payment)) {
        return { kind: 'cashPending' };
      }
      // Checkout VIVO = `externalUid` + algún medio: el MISMO criterio con que payment-service
      // clasifica PENDING_ACTION (un PENDING con medios pero sin externalUid no es accionable).
      return hasCheckout(payment) && payment.externalUid != null
        ? { kind: 'checkoutPending' }
        : { kind: 'processing' };
    case 'DEBT':
      return { kind: 'debt', failureReason: payment.failureReason ?? null };
    case 'FAILED':
      return { kind: 'failed' };
    case 'REFUNDED':
      return { kind: 'refunded', partial: false };
    case 'PARTIALLY_REFUNDED':
      return { kind: 'refunded', partial: true };
    default:
      return assertNever(payment.status);
  }
}

/**
 * Exhaustividad en compile-time: si un `PaymentStatus`/`PaymentOutcome` nuevo aparece y un switch
 * no lo maneja, el compilador frena ANTES de que el runtime caiga a una rama equivocada (la
 * lección de PARTIALLY_REFUNDED, ahora como gate y no como comentario).
 */
export function assertNever(value: never): never {
  throw new Error(`Estado de pago no contemplado: ${String(value)}`);
}
