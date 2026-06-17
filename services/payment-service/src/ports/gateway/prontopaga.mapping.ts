/**
 * Mapeos PUROS entre el dominio VEO y ProntoPaga (testeables sin red).
 *  - NUESTRO PaymentMethod → método de pago ProntoPaga (Perú).
 *  - Estado ProntoPaga (success/pending/...) → estado normalizado del puerto.
 *  - Body de webhook ProntoPaga → WebhookResult agnóstico.
 *
 * Fuente: docs.prontopaga.com (create-payment, payins-status, webhooks, yape-on-file).
 */
import type { GatewayPaymentMethod } from './payment-gateway.port';
import type { WebhookResult, WebhookStatus } from './payment-gateway.port';

/** Métodos de pago de ProntoPaga en Perú que usamos. */
export type ProntoPagaMethod =
  | 'yape_cof_payment' // Yape On File (afiliación activa): cobro recurrente server-initiated
  | 'yape_oneshot_payment' // Yape one-shot (sin afiliación): deepLink → el usuario aprueba en la app
  | 'pe_qr_3_payment' // QR Yape/Plin: el usuario escanea/abre y aprueba
  | 'pe_card_payment' // tarjeta (checkout hospedado)
  | 'pagoefectivo_payment'; // PagoEfectivo: CIP para pagar en agente/efectivo

/**
 * Vocabulario CRUDO de ProntoPaga (CONTRATO DEL PROVEEDOR, no dominio VEO). Vive en el ADAPTADOR
 * (§INTEGRACIONES: el adapter es dueño del lenguaje del proveedor; el dominio jamás compara estos
 * literales). Los mappers de abajo TRADUCEN estos valores a los estados normalizados del puerto
 * (`WebhookStatus`). Fuente: docs.prontopaga.com (payins-status · yape-on-file · webhooks).
 */

/** Estado de un payin ProntoPaga (doc payins-status, MINÚSCULA). 'cancelled' = variante defensiva de 'canceled'. */
export const ProntoPagaPayinStatus = {
  NEW: 'new',
  CREATED: 'created',
  PENDING: 'pending',
  SUCCESS: 'success',
  REJECTED: 'rejected',
  CANCELED: 'canceled',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
} as const;

/** Estado de una afiliación Yape On-File en ProntoPaga (MAYÚSCULA; /yape/subscription + /show). */
export const ProntoPagaAffiliationStatus = {
  ACCEPTED: 'ACCEPTED',
  ACTIVE: 'ACTIVE',
  SUCCESS: 'SUCCESS',
  AFFILIATED: 'AFFILIATED',
  PROCESS: 'PROCESS',
  EXPIRED: 'EXPIRED',
  REJECTED: 'REJECTED',
  CANCELED: 'CANCELED',
  CANCELLED: 'CANCELLED',
} as const;

/** Discriminador del webhook ProntoPaga (afiliación vs pago) + `method_type` de afiliación. */
export const ProntoPagaWebhookKind = { AFFILIATION: 'affiliation', PAYMENT: 'payment' } as const;
export const ProntoPagaMethodType = { YAPE_AFFILIATION: 'yape_affiliation' } as const;

/**
 * Mapea NUESTRO método → método ProntoPaga.
 *  - YAPE con `walletUid` (afiliación ACTIVE) → yape_cof_payment (on-file, server-initiated).
 *  - YAPE sin afiliación → yape_oneshot_payment: el flujo one-shot devuelve un deepLink (`yape.deepLink`)
 *    que abre la app Yape para aprobar. (El comercio de prueba público habilita yape_oneshot, NO
 *    pe_qr_3 — éste responde "paymentMethod not available". Confirmado contra el sandbox real.)
 *  - PLIN → pe_qr_3_payment (QR interoperable).
 *  - CARD → pe_card_payment.
 *  - PAGOEFECTIVO → pagoefectivo_payment.
 */
export function mapMethodToProntoPaga(
  method: GatewayPaymentMethod,
  hasWalletUid: boolean,
): ProntoPagaMethod {
  switch (method) {
    case 'YAPE':
      return hasWalletUid ? 'yape_cof_payment' : 'yape_oneshot_payment';
    case 'PLIN':
      return 'pe_qr_3_payment';
    case 'CARD':
      return 'pe_card_payment';
    case 'PAGOEFECTIVO':
      return 'pagoefectivo_payment';
  }
}

/**
 * Métodos que exigen el campo `origin` en /payment/new. yape_oneshot abre la app Yape por deepLink → mobile.
 * OJO: /payment/new acepta los valores en MINÚSCULA (`mobile`|`web`) — distinto de /yape/subscription, que
 * usa WEB|MOBILE en mayúscula (confirmado contra el sandbox real: 400 "Accepted values: mobile, web").
 * El firmador omite el campo cuando es undefined para el resto de métodos.
 */
export function originForMethod(ppMethod: ProntoPagaMethod): 'web' | 'mobile' | undefined {
  return ppMethod === 'yape_oneshot_payment' ? 'mobile' : undefined;
}

/**
 * Estado ProntoPaga → estado normalizado del puerto.
 * Doc payins-status: new → created → pending → success | rejected | canceled | expired.
 *   success                  → CONFIRMED
 *   rejected | canceled      → DECLINED
 *   expired                  → EXPIRED
 *   new | created | pending  → PENDING
 */
export function mapProntoPagaStatus(status: string): WebhookStatus {
  switch (status.toLowerCase()) {
    case ProntoPagaPayinStatus.SUCCESS:
      return 'CONFIRMED';
    case ProntoPagaPayinStatus.REJECTED:
    case ProntoPagaPayinStatus.CANCELED:
    case ProntoPagaPayinStatus.CANCELLED:
      return 'DECLINED';
    case ProntoPagaPayinStatus.EXPIRED:
      return 'EXPIRED';
    default:
      // new | created | pending | desconocido → tratamos como pendiente (no captura ni falla).
      return 'PENDING';
  }
}

/** Estado de afiliación Yape ProntoPaga → estado normalizado del webhook. */
export function mapAffiliationStatus(status: string): WebhookStatus {
  switch (status.toUpperCase()) {
    case ProntoPagaAffiliationStatus.ACTIVE:
    case ProntoPagaAffiliationStatus.SUCCESS:
    case ProntoPagaAffiliationStatus.AFFILIATED:
      return 'CONFIRMED';
    case ProntoPagaAffiliationStatus.EXPIRED:
      return 'EXPIRED';
    case ProntoPagaAffiliationStatus.REJECTED:
    case ProntoPagaAffiliationStatus.CANCELED:
    case ProntoPagaAffiliationStatus.CANCELLED:
      return 'DECLINED';
    default:
      // PROCESS | desconocido → sigue pendiente.
      return 'PENDING';
  }
}

/**
 * Normaliza un body de webhook ProntoPaga (ya verificada la firma) a WebhookResult.
 * Distingue afiliación de pago: si trae `wallet_uid`/`walletUID` o `method_type` de afiliación, es
 * `affiliation`; de lo contrario es `payment`. `order` es nuestra referencia (paymentId/affiliationId).
 */
export function normalizeWebhook(raw: Record<string, unknown>): WebhookResult {
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  const uid = str(raw.uid) ?? str(raw.reference) ?? '';
  const order = str(raw.order);
  const statusStr = str(raw.status) ?? '';

  // Un webhook de afiliación trae wallet_uid SIN un `order` de pago. Un cobro on-file rechazado por saldo
  // (YPTRX002) también incluye wallet_uid pero ES un pago (trae `order`=paymentId). Distinguimos por `order`:
  // si hay order, es un PAGO; si no, y hay wallet_uid/method_type de afiliación, es una AFILIACIÓN.
  const walletUid = str(raw.wallet_uid) ?? str(raw.walletUID) ?? str(raw.walletUid);
  const methodType = str(raw.method_type) ?? str(raw.methodType);
  const isAffiliation =
    !order &&
    (Boolean(walletUid) ||
      methodType === ProntoPagaMethodType.YAPE_AFFILIATION ||
      raw.kind === ProntoPagaWebhookKind.AFFILIATION);

  // Código de error del proveedor (p.ej. YPTRX002 = saldo insuficiente en el cobro on-file).
  const errorCode = str(raw.error_code) ?? str(raw.errorCode) ?? str(raw.code);

  return {
    kind: isAffiliation ? 'affiliation' : 'payment',
    externalId: uid,
    order,
    status: isAffiliation ? mapAffiliationStatus(statusStr) : mapProntoPagaStatus(statusStr),
    errorCode,
    raw,
  };
}
