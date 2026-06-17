/**
 * Adapter ProntoPaga (VEO_PAYMENT_MODE=prontopaga): agregador de pagos para Perú.
 * Implementa el puerto `PaymentGateway` + capacidades `WebhookVerifier` y `Refundable` (ISP).
 *
 * Fuente de verdad: docs.prontopaga.com. Endpoints usados:
 *   - POST /api/auth/sign-in        (auth: user/pass → token + refreshToken)        [si hay credenciales]
 *   - POST /api/payment/new         (crear cobro; body FIRMADO HMAC-SHA256)
 *   - POST /api/reverse/new         (reembolso; body FIRMADO)
 *   - POST /api/payment/yape/subscription  (afiliación Yape On File; body FIRMADO)  [AffiliationService]
 *
 * AUTH (cache de token): ProntoPaga autentica con un Bearer en la cabecera + firma HMAC del body.
 *   - Si hay `username`/`password`, hacemos sign-in y CACHEAMOS el token (re-sign-in al expirar;
 *     refreshToken si la respuesta lo trae).
 *   - Si NO hay user/pass pero SÍ un `apiToken` estático (sandbox público), lo usamos directo.
 * En AMBOS casos la firma del body usa `secretKey`.
 *
 * COBRO ASÍNCRONO: /payment/new NO captura síncronamente. Devuelve PENDING_EXTERNAL con el checkout
 * (urlPay/qrCode/deepLink/cip) y el resultado real (success/rejected/expired) llega por webhook.
 *
 * DEGRADACIÓN HONESTA: sin `secretKey` o sin (apiToken|username+password) el adapter LANZA al construirse
 * (no cobra a ciegas). El factory del módulo solo lo instancia en modo prontopaga.
 */
import { Logger } from '@nestjs/common';
import {
  ExternalServiceError,
  GatewayCapabilityUnavailableError,
  UnauthorizedError,
} from '@veo/utils';
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
  PaymentStatusQuery,
  PaymentStatusDetail,
} from './payment-gateway.port';
import { withSignature, verifySignature, type SignablePayload } from './prontopaga.signer';
import {
  mapMethodToProntoPaga,
  mapProntoPagaStatus,
  normalizeWebhook,
  originForMethod,
  ProntoPagaPayinStatus,
} from './prontopaga.mapping';
import {
  UndiciProntoPagaHttpClient,
  type ProntoPagaHttpClient,
} from './prontopaga.http-client';

export interface ProntoPagaGatewayOptions {
  baseUrl: string;
  secretKey: string;
  /** Token estático (sandbox público) — alternativa a username/password. */
  apiToken?: string;
  username?: string;
  password?: string;
  /** Base para construir urlConfirmation del webhook (urlConfirmation = `${webhookBaseUrl}/webhooks/prontopaga`). */
  webhookBaseUrl: string;
  timeoutMs?: number;
}

interface SignInResponse {
  token?: string;
  accessToken?: string;
  refreshToken?: string;
  /** Segundos hasta expirar (si el proveedor lo informa). */
  expiresIn?: number;
}

/**
 * Respuesta de /api/payment/new. Shape CONFIRMADO contra el sandbox real (2026-06-07):
 *   - SIEMPRE: `uid`, `reference`, `urlPay`.
 *   - pe_service_payment (PagoEfectivo): `cip` en el top level.
 *   - yape_oneshot_payment (origin=mobile): `deepLink` ANIDADO en `yape.deepLink` (NO top level),
 *     más `status:'created'`. El comercio de prueba público NO habilita `pe_qr_3_payment`, por eso
 *     `qrCode` no se ve en el sandbox actual (la doc lo muestra para QR directo). Lo seguimos leyendo
 *     defensivamente por si el comercio de prod lo habilita.
 */
interface CreatePaymentResponse {
  uid?: string;
  reference?: string;
  urlPay?: string;
  qrCode?: string;
  /** deepLink top-level (doc histórica / otros métodos). El de yape_oneshot viene en `yape.deepLink`. */
  deepLink?: string;
  /** Yape One Shot: el deepLink real viaja acá (`yape.deepLink`). */
  yape?: { id?: string; deepLink?: string };
  cip?: string;
  expiresAt?: string;
  status?: string;
  message?: string;
}

/**
 * Respuesta de GET /api/payment/data/{uid} (status query). Shape CONFIRMADO contra el sandbox real:
 *   200 OK con detalle → `{ uid, status:'new|created|pending|success|rejected|expired', amount, order, ... }`.
 *   uid inexistente → HTTP 200 (¡no 404!) con `{ error: 'payment not found.' }`.
 */
interface PaymentDataResponse {
  uid?: string;
  status?: string;
  order?: string;
  error?: string;
}

interface CachedToken {
  token: string;
  /** epoch ms en que el token deja de ser usable (con margen). */
  expiresAt: number;
  refreshToken?: string;
}

const TOKEN_SAFETY_MARGIN_MS = 30_000;
const DEFAULT_TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // 6h si el proveedor no informa expiry.

/**
 * Detección honesta del challenge HTML de Cloudflare en un body 401/403. Queda como red de seguridad:
 * con el cliente undici dedicado ya NO debería aparecer, pero si CF igual desafía (reputación de IP,
 * ráfaga), lo clasificamos como REINTENTABLE en lugar de confundirlo con un fallo de auth.
 */
function isCloudflareChallenge(body: string): boolean {
  return (
    body.includes('Cloudflare') ||
    body.includes('Attention Required') ||
    body.includes('cf-mitigated') ||
    body.includes('Just a moment')
  );
}

/**
 * Detecta el 400 de ProntoPaga que dice que el PRODUCTO/capacidad no está habilitado para el comercio
 * del entorno. NO es un error de validación de nuestro body ni transitorio: hasta que ProntoPaga habilite
 * el producto en el comercio (L0 comercial), reintentar es inútil. Se clasifica como capability error,
 * distinto del CF-403 (reintentable) y del 5xx (ExternalServiceError reintentable). Robusto a mayúsc/minúsc.
 *
 * DOS wordings CONFIRMADOS contra el sandbox real (2026-06-07), uno por path:
 *  - AFILIACIÓN (/yape/subscription): "The payment gateway is not enabled for commerce." (+ variantes).
 *  - COBRO (/payment/new) con un método no habilitado (p.ej. PLIN→pe_qr_3_payment):
 *      `{"error":{"paymentMethod":"paymentMethod, not available for this commerce."}}`.
 *    Hasta este fix ese wording caía como ExternalServiceError genérico → DEBT con failureReason crudo.
 */
function isCapabilityNotEnabled(body: string): boolean {
  const lower = body.toLowerCase();
  return (
    lower.includes('not enabled for commerce') ||
    lower.includes('gateway is not enabled') ||
    lower.includes('not enabled for the commerce') ||
    // COBRO: método no habilitado en el comercio (sandbox real: "not available for this commerce").
    lower.includes('not available for this commerce') ||
    lower.includes('not available for the commerce')
  );
}

export class ProntoPagaGateway
  implements PaymentGateway, WebhookVerifier, Refundable, PaymentStatusQuery
{
  /**
   * Capacidades DECLARADAS: AGREGADOR asíncrono (un intento; el desenlace llega por webhook/poll).
   * Habla TODOS los métodos digitales del puerto (`mapMethodToProntoPaga` es total sobre
   * GatewayPaymentMethod). La habilitación REAL por comercio se descubre en runtime
   * (failureKind=capability_unavailable); acá se declara el catálogo que el adapter sabe mapear.
   */
  readonly chargeFlow: GatewayChargeFlow = 'aggregator';

  private readonly logger = new Logger('ProntoPagaGateway');
  private readonly timeoutMs: number;
  private readonly webhookUrl: string;
  private cachedToken: CachedToken | null = null;
  /**
   * Cliente HTTP del adapter. Default: undici con Agent dedicado (NO el fetch global parcheado por OTel)
   * — ver prontopaga.http-client.ts para el porqué (Cloudflare 403). Inyectable para tests.
   */
  private readonly http: ProntoPagaHttpClient;

  constructor(
    private readonly opts: ProntoPagaGatewayOptions,
    httpClient?: ProntoPagaHttpClient,
  ) {
    if (!opts.baseUrl || !opts.secretKey) {
      throw new ExternalServiceError(
        'ProntoPaga requiere PRONTOPAGA_BASE_URL y PRONTOPAGA_SECRET_KEY (firma HMAC del body)',
      );
    }
    if (!opts.apiToken && !(opts.username && opts.password)) {
      throw new ExternalServiceError(
        'ProntoPaga requiere PRONTOPAGA_API_TOKEN o PRONTOPAGA_USERNAME+PRONTOPAGA_PASSWORD para autenticar',
      );
    }
    if (!opts.webhookBaseUrl) {
      throw new ExternalServiceError('ProntoPaga requiere PRONTOPAGA_WEBHOOK_BASE_URL para armar urlConfirmation');
    }
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.webhookUrl = `${opts.webhookBaseUrl.replace(/\/$/, '')}/api/v1/webhooks/prontopaga`;
    this.http = httpClient ?? new UndiciProntoPagaHttpClient();
  }

  supports(_method: GatewayPaymentMethod): boolean {
    // El mapeo a métodos ProntoPaga es TOTAL (ver mapMethodToProntoPaga): todo método digital del
    // puerto se sabe cobrar por el agregador.
    return true;
  }

  /* ───────────────────────────────── AUTH (token cacheado) ───────────────────────────────── */

  private async getToken(): Promise<string> {
    // Token estático (sandbox público): no expira desde nuestra perspectiva.
    if (this.opts.apiToken && !this.opts.username) return this.opts.apiToken;

    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt - TOKEN_SAFETY_MARGIN_MS > now) {
      return this.cachedToken.token;
    }
    return this.signIn();
  }

  private async signIn(): Promise<string> {
    const res = await this.rawRequest<SignInResponse>('POST', '/api/auth/sign-in', {
      username: this.opts.username,
      password: this.opts.password,
    });
    const token = res.token ?? res.accessToken;
    if (!token) {
      throw new ExternalServiceError('ProntoPaga sign-in no devolvió token');
    }
    const ttlMs = res.expiresIn ? res.expiresIn * 1000 : DEFAULT_TOKEN_TTL_MS;
    this.cachedToken = { token, expiresAt: Date.now() + ttlMs, refreshToken: res.refreshToken };
    this.logger.log('ProntoPaga: token de acceso renovado (cacheado)');
    return token;
  }

  /* ───────────────────────────────────── CHARGE ───────────────────────────────────────── */

  async charge(req: GatewayChargeRequest): Promise<GatewayChargeResult> {
    const ppMethod = mapMethodToProntoPaga(req.method, Boolean(req.walletUid));
    // céntimos → string decimal "12.50" (ProntoPaga exige amount como STRING).
    const amount = (req.amountCents / 100).toFixed(2);
    const c = req.client ?? {};

    // Body firmable. `order` = paymentId (idempotencia por referencia única; no hay header documentado).
    const payload: SignablePayload = {
      amount,
      clientDocument: c.document ?? '00000000',
      clientDocumentType: c.documentType ?? 'DN',
      clientEmail: c.email ?? 'noreply@veo.pe',
      clientName: c.name ?? 'Cliente VEO',
      clientPhone: c.phone ?? req.payerRef ?? '000000000',
      country: 'PE',
      currency: 'PEN',
      order: req.paymentId,
      // origin (WEB|MOBILE) lo EXIGE yape_oneshot (deepLink abre la app Yape → MOBILE). El firmador
      // omite undefined para el resto de métodos. Sin esto, /payment/new responde 400 "origin required".
      origin: originForMethod(ppMethod),
      paymentMethod: ppMethod,
      urlConfirmation: this.webhookUrl,
      urlFinal: `${this.webhookUrl}/final`,
      urlRejected: `${this.webhookUrl}/rejected`,
      // wallet_uid (snake_case) SOLO en on-file (Yape afiliado). OJO: en /payment/new el campo es
      // `wallet_uid`, distinto del `walletUID` de /subscription. El firmador omite undefined.
      wallet_uid: req.walletUid,
    };

    let body: CreatePaymentResponse;
    try {
      body = await this.request<CreatePaymentResponse>('POST', '/api/payment/new', payload);
    } catch (err) {
      // CAPACIDAD no habilitada en el path de COBRO: ProntoPaga respondió 400 "not enabled for
      // commerce" para ESTE método (rawRequest ya lo clasificó como GatewayCapabilityUnavailableError).
      // En afiliación se PROPAGA (422). En COBRO NO lo propagamos como excepción genérica que el dominio
      // aplastaría a un failureReason crudo: lo devolvemos como un DECLINE TIPADO (failureKind=
      // capability_unavailable) para que el Payment caiga a DEBT con una razón honesta por-método y la app
      // sugiera otro medio en vez de "reintentá" (reintentar el mismo método es inútil hasta L0 comercial).
      if (err instanceof GatewayCapabilityUnavailableError) {
        this.logger.warn(
          `ProntoPaga: método ${req.method} NO habilitado para el comercio (cobro pago=${req.paymentId}); ` +
            `clasificado capability_unavailable (no reintentable con el mismo método)`,
        );
        return {
          status: 'DECLINED',
          failureKind: 'capability_unavailable',
          reason: (err.details?.body as string | undefined) ?? err.message,
        };
      }
      // Cualquier otro fallo (red/5xx/auth) → RELANZA: es transitorio/reintentable, lo maneja el bucle
      // de reintentos del dominio (processGatewayCharge) o cae a DEBT con la razón de la excepción.
      throw err;
    }

    const externalRef = body.uid ?? body.reference;
    if (!externalRef) {
      // Sin uid no podemos correlacionar el webhook → tratamos como rechazo honesto.
      return { status: 'DECLINED', reason: body.message ?? 'prontopaga_sin_uid' };
    }

    // /payment/new no captura síncrono: queda PENDING_EXTERNAL; el webhook (o el poll) trae el desenlace.
    // deepLink: yape_oneshot lo anida en `yape.deepLink`; otros métodos podrían traerlo top-level.
    return {
      status: 'PENDING_EXTERNAL',
      externalRef,
      checkout: {
        urlPay: body.urlPay,
        qrCodeBase64: body.qrCode,
        deepLink: body.yape?.deepLink ?? body.deepLink,
        cip: body.cip,
        expiresAt: body.expiresAt,
      },
    };
  }

  /**
   * ProntoPaga no expone un extracto de settlement consultable por nosotros (la conciliación se hace
   * contra los webhooks ya capturados en DB). Devolvemos vacío: la conciliación cae al libro propio.
   */
  async getStatement(): Promise<GatewayStatementEntry[]> {
    this.logger.debug('ProntoPaga: getStatement no soportado por el proveedor; conciliación por DB/webhooks');
    return [];
  }

  /* ───────────────────────────── STATUS QUERY (poll fallback) ──────────────────────────── */

  /**
   * Consulta el estado de un cobro por su uid: GET /api/payment/data/{uid} (Bearer, SIN firma de body).
   * Habilita el poll fallback cuando el webhook no llega (localhost sin túnel). Defensivo:
   *   - `{ error: 'payment not found.' }` (HTTP 200) → found=false (uid desconocido para el proveedor).
   *   - status crudo (new|created|pending|success|rejected|expired) → normalizado por mapProntoPagaStatus.
   * NO firma el body (es GET); reutiliza el Bearer cacheado/estático vía getToken().
   */
  async getPaymentStatus(externalUid: string): Promise<PaymentStatusDetail> {
    const body = await this.rawRequest<PaymentDataResponse>(
      'GET',
      `/api/payment/data/${encodeURIComponent(externalUid)}`,
      undefined,
      await this.getToken(),
    );
    // uid inexistente: ProntoPaga responde 200 con `{error:'payment not found.'}`, NO un 404.
    if (body.error || !body.status) {
      return { found: false, status: 'PENDING' };
    }
    return { found: true, status: mapProntoPagaStatus(body.status), rawStatus: body.status };
  }

  /* ──────────────────────────────────── WEBHOOK ───────────────────────────────────────── */

  verifyWebhook(rawBody: string): WebhookResult {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new UnauthorizedError('Webhook ProntoPaga: body no es JSON válido');
    }
    const { sign, ...rest } = parsed as { sign?: string } & Record<string, unknown>;
    if (!verifySignature(rest as SignablePayload, this.opts.secretKey, sign)) {
      throw new UnauthorizedError('Webhook ProntoPaga: firma inválida');
    }
    return normalizeWebhook(parsed);
  }

  /* ──────────────────────────────────── REFUND ────────────────────────────────────────── */

  /**
   * Reverso de un cobro capturado: POST /api/reverse/new (body FIRMADO). ASÍNCRONO: ProntoPaga acepta
   * el reverso y confirma por callback a `urlCallbackRefund` → ruta DEDICADA /refund (la ruta clasifica
   * el evento; el payload del reverso no trae un marcador confiable de tipo).
   *
   * `meta.idempotencyKey` NO viaja al proveedor: /reverse/new no documenta campo de idempotencia. La
   * idempotencia del reverso la garantiza el DOMINIO (Refund PENDING persistido antes de llamar +
   * claim transaccional); por lo mismo, un fallo de red NO se reintenta a ciegas desde acá.
   *
   * TIMEOUT ≠ FALLA (INTEGRACIONES §4): un fallo transitorio (red/5xx/CF) se RELANZA — el dominio NO
   * marca el Refund como rechazado (no sabemos si el proveedor recibió el reverso); lo cierra el
   * callback o la conciliación. Solo un rechazo REAL del proveedor devuelve REJECTED.
   */
  async refund(externalRef: string, amountCents: number, meta?: RefundMeta): Promise<RefundResult> {
    const payload: SignablePayload = {
      amount: (amountCents / 100).toFixed(2),
      clientDocument: meta?.clientDocument ?? '00000000',
      reference: externalRef,
      urlCallbackRefund: meta?.urlCallbackRefund ?? `${this.webhookUrl}/refund`,
    };
    let body: { uid?: string; status?: string; message?: string };
    try {
      body = await this.request<{ uid?: string; status?: string; message?: string }>(
        'POST',
        '/api/reverse/new',
        payload,
      );
    } catch (err) {
      // Capacidad no habilitada en el comercio (400 tipado): rechazo PERMANENTE, no transitorio.
      if (err instanceof GatewayCapabilityUnavailableError) {
        return { status: 'REJECTED', reason: err.message };
      }
      throw err; // red/5xx/timeout → transitorio: el dominio deja el Refund PENDING (timeout ≠ falla).
    }
    const status = (body.status ?? '').toLowerCase();
    if (
      status === ProntoPagaPayinStatus.REJECTED ||
      status === ProntoPagaPayinStatus.CANCELED ||
      status === ProntoPagaPayinStatus.CANCELLED
    ) {
      return { status: 'REJECTED', reason: body.message ?? `reverse_${status}` };
    }
    // ProntoPaga reembolsa de forma asíncrona (callback): aceptado a la espera de confirmación.
    return { status: 'PENDING', externalRefundId: body.uid };
  }

  /* ──────────────────────────────── HTTP helpers ──────────────────────────────────────── */

  /** Request FIRMADO y AUTENTICADO: firma el body con secretKey y adjunta el Bearer cacheado. */
  private async request<T>(method: 'GET' | 'POST', path: string, payload: SignablePayload): Promise<T> {
    const token = await this.getToken();
    const signed = withSignature(payload, this.opts.secretKey);
    return this.rawRequest<T>(method, path, signed, token);
  }

  /** Request crudo (sin firma) — usado por sign-in y como base del firmado. */
  private async rawRequest<T>(
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown,
    bearer?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      // User-Agent estable: ProntoPaga está detrás de Cloudflare, que desafía/bloquea (403 con
      // challenge HTML) a clientes sin UA bajo ráfaga o bot-detection. Un UA identificable evita el
      // managed challenge sin disfrazarse de browser. Confirmado: el 403 es de Cloudflare, NO de la API.
      'user-agent': 'VEO-Payment/1.0 (+https://veo.pe)',
    };
    const token = bearer ?? this.opts.apiToken;
    if (token) headers.authorization = `Bearer ${token}`;

    let res: { status: number; text(): Promise<string> };
    try {
      // El transporte usa undici con Agent dedicado (NO el fetch global parcheado por OTel) — ver
      // prontopaga.http-client.ts. El timeout y abort los maneja undici (headersTimeout/bodyTimeout).
      res = await this.http.send({
        method,
        url: `${this.opts.baseUrl}${path}`,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'error desconocido';
      this.logger.error(`Fallo de red contra ProntoPaga: ${message}`);
      throw new ExternalServiceError(`No se pudo contactar ProntoPaga: ${message}`);
    }

    if (res.status === 401 || res.status === 403) {
      // 401/403: token inválido O challenge de Cloudflare (bot/rate). Invalidamos el token cacheado
      // (defensivo) y detectamos el challenge HTML para un mensaje honesto en el log/recibo. El
      // CF-challenge queda como error REINTENTABLE (failureReason explícito); el resto, no-auth.
      this.cachedToken = null;
      const text = await res.text().catch(() => '');
      const cloudflare = isCloudflareChallenge(text);
      throw new ExternalServiceError(
        cloudflare
          ? `ProntoPaga: bloqueado por Cloudflare (${res.status}; bot/rate challenge, reintentable)`
          : `ProntoPaga rechazó la autenticación (${res.status})`,
        { body: text.slice(0, 300) },
      );
    }
    if (res.status < 200 || res.status >= 300) {
      const text = await res.text().catch(() => '');
      // 400 "not enabled for commerce": el PRODUCTO no está habilitado en el comercio del entorno.
      // NO reintentable (lo habilita ProntoPaga = L0 comercial). Lo clasificamos como capability error
      // tipado, distinto del 5xx (ExternalServiceError reintentable). La `capability` se deriva del path
      // (la afiliación Yape On File pega a /yape/subscription).
      if (res.status === 400 && isCapabilityNotEnabled(text)) {
        // capability del PATH: afiliación → YAPE_ON_FILE; cobro (/payment/new) → PAYMENT_METHOD (el
        // método concreto lo deriva el dominio desde el GatewayChargeRequest, no de este error).
        const capability = path.includes('/yape/subscription') ? 'YAPE_ON_FILE' : 'PAYMENT_METHOD';
        this.logger.warn(
          `ProntoPaga: capacidad NO habilitada para el comercio (${capability}); reintentar es inútil hasta habilitación comercial (L0). path=${path}`,
        );
        throw new GatewayCapabilityUnavailableError(
          `ProntoPaga: la capacidad ${capability} no está habilitada para este comercio`,
          { capability, body: text.slice(0, 300) },
        );
      }
      throw new ExternalServiceError(`ProntoPaga respondió ${res.status}`, { body: text.slice(0, 500) });
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * Crea una afiliación Yape On File (patrón PedidosYa). Lo usa AffiliationService (mismo cliente firmado).
   * En origin=MOBILE el `phoneNumber` se OMITE (el deepLink abre la app Yape directo); solo se manda en WEB.
   * La respuesta trae `uid` (= walletUID de la afiliación) y, en MOBILE, `phoneNumber: null` hasta aceptar.
   */
  async createYapeSubscription(input: {
    origin: 'WEB' | 'MOBILE';
    document: string;
    clientDocumentType: 'DN' | 'CE' | 'PP';
    phoneNumber?: string;
    clientName: string;
    type: 'RECURRENT' | 'ON_DEMAND';
  }): Promise<{ uid?: string; status?: string; deepLink?: string; phoneNumber?: string | null }> {
    const payload: SignablePayload = {
      clientDocumentType: input.clientDocumentType,
      clientName: input.clientName,
      document: input.document,
      origin: input.origin,
      // Solo WEB lleva phoneNumber. En MOBILE se omite (el firmador ignora undefined).
      phoneNumber: input.origin === 'WEB' ? input.phoneNumber : undefined,
      type: input.type,
      webhookUrl: this.webhookUrl,
    };
    return this.request('POST', '/api/payment/yape/subscription', payload);
  }

  /**
   * Consulta el detalle/estado de una suscripción Yape (fallback al webhook de afiliación, no documentado).
   * POST /api/payment/yape/subscription/{walletUID}/show → status (ACCEPTED|PROCESS|EXPIRED) + phoneNumber.
   * Body firmado mínimo (walletUID en la URL); algunos endpoints sin body igual aceptan firma vacía.
   */
  async showYapeSubscription(
    walletUid: string,
  ): Promise<{ uid?: string; status?: string; phoneNumber?: string | null }> {
    return this.request(
      'POST',
      `/api/payment/yape/subscription/${encodeURIComponent(walletUid)}/show`,
      {},
    );
  }

  /**
   * Cancela (da de baja) una afiliación Yape en el proveedor. POST .../cancel/{walletUID} (Bearer, sin sign).
   * El usuario recibe un push de Yape al desafiliarse. Lanza ExternalServiceError si el proveedor falla.
   */
  async cancelYapeSubscription(walletUid: string): Promise<void> {
    await this.rawRequest<{ message?: string }>(
      'POST',
      `/api/payment/yape/subscription/cancel/${encodeURIComponent(walletUid)}`,
      undefined,
      await this.getToken(),
    );
  }
}
