/**
 * Adapter SANDBOX del riel: red de pagos determinista en proceso.
 * - Confirma la mayoría de cobros tras un pequeño delay (simula la latencia del riel).
 * - Declina de forma DETERMINISTA los cobros cuyo `payerRef` termina en `declineSuffix`
 *   (permite probar el camino de DEBT sin cuentas reales).
 * - Mantiene su propio libro mayor en memoria para servir extractos a la conciliación (BR-P07).
 * - Modo PENDING_EXTERNAL (`pendingExternal: true`): simula el flujo asíncrono de un agregador
 *   (ProntoPaga) — el cobro queda PENDIENTE devolviendo checkout y el resultado real llega por webhook.
 *   Para tests sin red, expone `verifyWebhook` con el MISMO firmador/secret de ProntoPaga y un helper
 *   `buildSignedWebhook` que arma un body firmado (lo usan e2e y el smoke del boot-real).
 *
 * No es un mock de test: es un adapter real, seleccionable por VEO_PAYMENT_MODE=sandbox.
 */
import { Logger } from '@nestjs/common';
import { UnauthorizedError } from '@veo/utils';
import type {
  PaymentGateway,
  GatewayChargeFlow,
  GatewayChargeRequest,
  GatewayChargeResult,
  GatewayPaymentMethod,
  GatewayStatementEntry,
  WebhookVerifier,
  WebhookResult,
  Refundable,
  RefundResult,
  RefundMeta,
} from './payment-gateway.port';
import { signPayload, verifySignature, type SignablePayload } from './prontopaga.signer';
import { mapProntoPagaStatus, normalizeWebhook } from './prontopaga.mapping';

/** Catálogo del riel directo simulado: Yape/Plin (espeja al adapter `live`). */
const DIRECT_METHODS: ReadonlySet<GatewayPaymentMethod> = new Set(['YAPE', 'PLIN']);
/** Catálogo del modo agregador simulado: espeja a ProntoPaga (Yape/Plin/tarjeta/PagoEfectivo). */
const AGGREGATOR_METHODS: ReadonlySet<GatewayPaymentMethod> = new Set(['YAPE', 'PLIN', 'CARD', 'PAGOEFECTIVO']);

interface LedgerEntry {
  externalRef: string;
  amountCents: number;
  at: Date;
}

export interface SandboxGatewayOptions {
  confirmDelayMs: number;
  declineSuffix: string;
  /**
   * Si true, `charge` NO captura síncronamente: devuelve PENDING_EXTERNAL con checkout simulado
   * (espeja a ProntoPaga). La captura llega por `verifyWebhook`. Default false (compat: confirma sync).
   */
  pendingExternal?: boolean;
  /** Secret para firmar/verificar webhooks simulados (igual semántica que ProntoPaga). */
  webhookSecret?: string;
}

export class SandboxPaymentGateway implements PaymentGateway, WebhookVerifier, Refundable {
  private readonly logger = new Logger('SandboxPaymentGateway');
  private readonly ledger: LedgerEntry[] = [];
  /** Reversos aceptados, por id determinista (idempotencia: re-llamar con la misma key no duplica). */
  private readonly refunds = new Map<string, { externalRef: string; amountCents: number }>();

  constructor(private readonly opts: SandboxGatewayOptions) {}

  /**
   * Capacidades DECLARADAS (contrato base del puerto): con `pendingExternal` el sandbox espeja a un
   * AGREGADOR (flujo asíncrono + catálogo de 4 métodos, como ProntoPaga); sin él, al riel DIRECTO
   * (síncrono, solo Yape/Plin, como `live`). El dominio despacha según esto, no según el env.
   */
  get chargeFlow(): GatewayChargeFlow {
    return this.opts.pendingExternal ? 'aggregator' : 'direct';
  }

  supports(method: GatewayPaymentMethod): boolean {
    return (this.opts.pendingExternal ? AGGREGATOR_METHODS : DIRECT_METHODS).has(method);
  }

  async charge(req: GatewayChargeRequest): Promise<GatewayChargeResult> {
    if (this.opts.confirmDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.opts.confirmDelayMs));
    }

    if (this.opts.declineSuffix && req.payerRef?.endsWith(this.opts.declineSuffix)) {
      this.logger.warn(`[SANDBOX ${req.method}] cobro declinado (payerRef de prueba) tx=${req.paymentId}`);
      return { status: 'DECLINED', reason: 'INSUFFICIENT_FUNDS' };
    }

    // Referencia determinista por pago (re-cobrar el mismo pago no duplica el extracto).
    const externalRef = `sbx_${req.method.toLowerCase()}_${req.paymentId}`;

    // Modo asíncrono: el cobro queda PENDIENTE y se completa por webhook (espeja ProntoPaga).
    if (this.opts.pendingExternal) {
      this.logger.log(`[SANDBOX ${req.method}] cobro PENDIENTE externo tx=${externalRef} (espera webhook)`);
      const checkout = req.walletUid
        ? // On-file: sin checkout (el usuario aprueba en su app, confirma por webhook).
          undefined
        : { qrCodeBase64: `data:image/png;base64,${Buffer.from(externalRef).toString('base64')}`, urlPay: `https://sandbox.local/pay/${externalRef}` };
      return { status: 'PENDING_EXTERNAL', externalRef, checkout };
    }

    if (!this.ledger.some((e) => e.externalRef === externalRef)) {
      this.ledger.push({ externalRef, amountCents: req.amountCents, at: new Date() });
    }
    this.logger.log(`[SANDBOX ${req.method}] cobro confirmado tx=${externalRef} monto=${req.amountCents}`);
    return { status: 'CONFIRMED', externalRef };
  }

  /**
   * Reembolso DETERMINISTA y SÍNCRONO (capacidad `Refundable`, ISP del puerto). No es un mock de test:
   * es la red de pagos en proceso devolviendo la plata en el acto. El id del reverso se deriva de la
   * idempotency key del dominio (INTEGRACIONES §4): re-llamar con la MISMA key devuelve el MISMO
   * reverso sin duplicar (idempotente, espeja el contrato de un proveedor con idempotencia real).
   */
  async refund(externalRef: string, amountCents: number, meta?: RefundMeta): Promise<RefundResult> {
    const externalRefundId = `sbx_refund_${meta?.idempotencyKey ?? externalRef}`;
    if (!this.refunds.has(externalRefundId)) {
      this.refunds.set(externalRefundId, { externalRef, amountCents });
      this.logger.log(`[SANDBOX] reverso confirmado ${externalRefundId} sobre tx=${externalRef} monto=${amountCents}`);
    }
    return { status: 'ACCEPTED', externalRefundId };
  }

  async getStatement(periodStart: Date, periodEnd: Date): Promise<GatewayStatementEntry[]> {
    return this.ledger
      .filter((e) => e.at >= periodStart && e.at < periodEnd)
      .map((e) => ({ externalRef: e.externalRef, amountCents: e.amountCents }));
  }

  /**
   * Verifica un webhook simulado con el MISMO firmador de ProntoPaga (firma sobre todos los campos
   * salvo `sign`, timing-safe). Permite e2e y smoke del webhook sin red externa.
   */
  verifyWebhook(rawBody: string): WebhookResult {
    const secret = this.opts.webhookSecret ?? '';
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new UnauthorizedError('Webhook sandbox: body no es JSON válido');
    }
    const { sign, ...rest } = parsed as { sign?: string } & Record<string, unknown>;
    if (!verifySignature(rest as SignablePayload, secret, sign)) {
      throw new UnauthorizedError('Webhook sandbox: firma inválida');
    }
    return normalizeWebhook(parsed);
  }

  /**
   * Helper de PRUEBA: arma un body de webhook YA FIRMADO con el secret del adapter (para e2e/smoke).
   * No es parte del puerto; lo usan los tests y el script de boot-real.
   */
  buildSignedWebhook(fields: Record<string, string | number>): { body: string; status: ReturnType<typeof mapProntoPagaStatus> } {
    const secret = this.opts.webhookSecret ?? '';
    const sign = signPayload(fields, secret);
    return { body: JSON.stringify({ ...fields, sign }), status: mapProntoPagaStatus(String(fields.status ?? '')) };
  }
}
