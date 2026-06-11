/**
 * Adapter LIVE del riel Yape/Plin: API directa del proveedor (sin SaaS intermediario).
 * Habla HTTP/JSON con el gateway del proveedor usando credenciales propias (merchant + apiKey).
 * Requiere PAYMENT_GATEWAY_URL/API_KEY/MERCHANT_ID; si faltan, lanza (no falla en silencio).
 *
 * NOTA DE CONTRATO: la forma exacta del request/response depende del convenio con el proveedor
 * de cobros Yape/Plin (BCP/Niubiz collections API). Aquí se implementa el contrato HTTP genérico;
 * al cerrar el convenio se ajustan los nombres de campos a su especificación.
 */
import { Logger } from '@nestjs/common';
import { ExternalServiceError } from '@veo/utils';
import type {
  PaymentGateway,
  GatewayChargeFlow,
  GatewayChargeRequest,
  GatewayChargeResult,
  GatewayPaymentMethod,
  GatewayStatementEntry,
} from './payment-gateway.port';

/** Catálogo del riel directo: solo Yape/Plin (tarjeta/PagoEfectivo no tienen riel directo — van por agregador). */
const SUPPORTED_METHODS: ReadonlySet<GatewayPaymentMethod> = new Set(['YAPE', 'PLIN']);

export interface LiveGatewayOptions {
  baseUrl: string;
  apiKey: string;
  merchantId: string;
  timeoutMs?: number;
}

interface ChargeResponseBody {
  status?: string;
  transactionId?: string;
  declineReason?: string;
}

interface StatementResponseBody {
  entries?: { transactionId?: string; amountCents?: number }[];
}

export class LivePaymentGateway implements PaymentGateway {
  /** Capacidades DECLARADAS: riel directo SÍNCRONO (el dominio reintenta con backoff), solo Yape/Plin. */
  readonly chargeFlow: GatewayChargeFlow = 'direct';

  private readonly logger = new Logger('LivePaymentGateway');
  private readonly timeoutMs: number;

  supports(method: GatewayPaymentMethod): boolean {
    return SUPPORTED_METHODS.has(method);
  }

  constructor(private readonly opts: LiveGatewayOptions) {
    if (!opts.baseUrl || !opts.apiKey || !opts.merchantId) {
      throw new ExternalServiceError(
        'PaymentGateway en modo live requiere PAYMENT_GATEWAY_URL, PAYMENT_GATEWAY_API_KEY y PAYMENT_GATEWAY_MERCHANT_ID',
      );
    }
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async charge(req: GatewayChargeRequest): Promise<GatewayChargeResult> {
    const body = await this.request<ChargeResponseBody>('POST', '/v1/collections', {
      merchantId: this.opts.merchantId,
      // `idempotencyKey` evita doble cobro si reintentamos la llamada de red.
      idempotencyKey: req.paymentId,
      method: req.method,
      amountCents: req.amountCents,
      currency: 'PEN',
      payerRef: req.payerRef,
      reference: req.tripId,
    });

    const status = (body.status ?? '').toUpperCase();
    if (status === 'CONFIRMED' || status === 'APPROVED' || status === 'PAID') {
      return { status: 'CONFIRMED', externalRef: body.transactionId };
    }
    return { status: 'DECLINED', reason: body.declineReason ?? `gateway_status_${status || 'UNKNOWN'}` };
  }

  async getStatement(periodStart: Date, periodEnd: Date): Promise<GatewayStatementEntry[]> {
    const query = `?merchantId=${encodeURIComponent(this.opts.merchantId)}&from=${periodStart.toISOString()}&to=${periodEnd.toISOString()}`;
    const body = await this.request<StatementResponseBody>('GET', `/v1/settlements${query}`);
    return (body.entries ?? [])
      .filter((e): e is { transactionId: string; amountCents: number } =>
        typeof e.transactionId === 'string' && typeof e.amountCents === 'number',
      )
      .map((e) => ({ externalRef: e.transactionId, amountCents: e.amountCents }));
  }

  private async request<T>(method: 'GET' | 'POST', path: string, payload?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.opts.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ExternalServiceError(`Riel de pago respondió ${res.status}`, { body: text.slice(0, 500) });
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof ExternalServiceError) throw err;
      const message = err instanceof Error ? err.message : 'error desconocido';
      this.logger.error(`Fallo de red contra el riel: ${message}`);
      throw new ExternalServiceError(`No se pudo contactar el riel de pago: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
