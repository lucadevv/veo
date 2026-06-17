/**
 * Puerto propio `PaymentGateway` (FOUNDATION §9).
 * El riel Yape/Plin/ProntoPaga es el ÚNICO componente externo inevitable; se encapsula tras este puerto.
 * Adapters reales y seleccionables por env `VEO_PAYMENT_MODE`:
 *   - `live`       → API directa del proveedor (sin SaaS intermediario).
 *   - `sandbox`    → red de pagos determinista en proceso (confirma tras delay, lleva su propio
 *                    libro mayor para conciliación). NO es un mock de test: es un adapter real.
 *   - `prontopaga` → agregador ProntoPaga (Yape/Plin/tarjeta/PagoEfectivo en Perú). Cobro asíncrono:
 *                    el usuario completa el pago FUERA (QR/deepLink/CIP) y el resultado llega por webhook.
 * El efectivo (CASH) no pasa por el gateway (confirmación bilateral, BR-P03).
 *
 * DISEÑO SOLID/ISP: el contrato base `PaymentGateway` solo exige lo que TODO adapter cumple
 * (charge + getStatement + sus capacidades DECLARADAS: `chargeFlow` y `supports`). Las capacidades
 * opcionales del proveedor —verificar webhooks y reembolsar— viven en interfaces SEPARADAS
 * (`WebhookVerifier`, `Refundable`) que un adapter implementa si las soporta. El dominio consulta la
 * capacidad con los type-guards (`supportsWebhooks`, `supportsRefund`) en vez de obligar a cada
 * adapter a stubbear métodos que no aplican.
 *
 * CAPACIDADES DE COBRO (misma filosofía que los type-guards, pero en el contrato BASE): cobrar es la
 * capacidad obligatoria de todo gateway, así que sus metadatos de despacho —qué métodos cobra
 * (`supports`) y con qué flujo (`chargeFlow`)— son OBLIGATORIOS, no opcionales: si fueran type-guards
 * opcionales, el dominio necesitaría una rama default silenciosa para los adapters que no declaran
 * (exactamente lo que está prohibido). El env `VEO_PAYMENT_MODE` lo mira SOLO la factory que elige el
 * adapter (payment-gateway.module); el dominio pregunta al puerto y JAMÁS vuelve a mirar el env —
 * agregar un proveedor = un adapter nuevo + cableado en la factory, CERO ediciones en el dominio.
 */
import type { PaymentMethod } from '@veo/shared-types';

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

/** Métodos digitales enrutables al gateway (CASH se confirma bilateral, fuera del puerto). */
export type GatewayPaymentMethod = Extract<
  PaymentMethod,
  'YAPE' | 'PLIN' | 'CARD' | 'PAGOEFECTIVO'
>;

/**
 * Flujo de cobro que el adapter IMPLEMENTA y DECLARA (el dominio despacha preguntándole al puerto,
 * nunca re-derivándolo del env):
 *  - 'aggregator' → cobro asíncrono de UN intento: `charge` devuelve PENDING_EXTERNAL con checkout
 *                   y el desenlace llega por webhook/poll (ProntoPaga; sandbox con pendingExternal).
 *  - 'direct'     → riel síncrono: el dominio reintenta con backoff y conoce el desenlace en línea
 *                   (live; sandbox clásico).
 */
export type GatewayChargeFlow = 'aggregator' | 'direct';

export interface GatewayChargeRequest {
  /** id del Payment de dominio (UUIDv7); el adapter lo usa para trazabilidad/idempotencia (order único). */
  paymentId: string;
  tripId: string;
  /** Monto a cobrar en céntimos PEN (bruto + propina). */
  amountCents: number;
  method: GatewayPaymentMethod;
  /** Referencia del pagador en el riel (teléfono/token Yape-Plin). */
  payerRef?: string;
  /**
   * Datos del cliente exigidos por algunos proveedores (ProntoPaga pide nombre/email/doc en /payment/new).
   * Opcionales: el adapter sandbox/live los ignora; ProntoPaga cae a placeholders honestos si faltan.
   */
  client?: {
    name?: string;
    email?: string;
    phone?: string;
    document?: string;
    documentType?: 'DN' | 'CE' | 'PP';
  };
  /**
   * UID de afiliación de wallet (Yape On File). Si está presente y el método es YAPE, el adapter
   * cobra ON-FILE (server-initiated, sin checkout): el usuario aprueba en su app Yape y confirma por webhook.
   * NUNCA se persiste en el Payment ni sale en DTOs: lo resuelve el dominio desde WalletAffiliation.
   */
  walletUid?: string;
}

/**
 * Resultado del cobro:
 *  - CONFIRMED        → el riel capturó síncronamente (sandbox/live histórico). `externalRef` presente.
 *  - DECLINED         → el riel rechazó síncronamente. `reason` presente.
 *  - PENDING_EXTERNAL → el cobro quedó pendiente; el usuario lo completa FUERA (QR/deepLink/CIP) o
 *                       el on-file confirma por webhook. `externalRef` = uid del proveedor; `checkout`
 *                       lleva los datos para que la app muestre el medio de pago. La captura llega luego
 *                       por `verifyWebhook` → transición PENDING→CAPTURED.
 */
export type GatewayChargeStatus = 'CONFIRMED' | 'DECLINED' | 'PENDING_EXTERNAL';

/**
 * Clasificación HONESTA del por qué falló un cobro (solo aplica cuando status=DECLINED). Distingue
 * tres mundos que el dominio trata distinto en el recibo y en el gate:
 *  - `declined`              → el riel rechazó el cobro (saldo, riesgo, datos). Reintentar PUEDE servir.
 *  - `capability_unavailable`→ el MÉTODO no está habilitado en el comercio del entorno (ProntoPaga 400
 *                              "not enabled for commerce"). Reintentar con el MISMO método es INÚTIL hasta
 *                              habilitación comercial (L0): la app debe sugerir OTRO método, no "reintentá".
 *  - `transient`             → fallo pasajero (red/5xx). El dominio lo reintenta; no cae a este result si
 *                              el adapter ya relanza la excepción (ExternalServiceError) para que el bucle
 *                              de reintentos la maneje.
 * Omitido en CONFIRMED / PENDING_EXTERNAL (no hubo fallo).
 */
export type GatewayChargeFailureKind = 'declined' | 'capability_unavailable' | 'transient';

/** Datos de checkout para que el pasajero complete el pago fuera de la app (BR-P01 ProntoPaga). */
export interface GatewayCheckout {
  /** URL hospedada del proveedor para completar el pago (tarjeta/QR web). */
  urlPay?: string;
  /** QR como data-URI PNG base64 (`data:image/png;base64,...`) para pintar en la app (Yape/Plin QR). */
  qrCodeBase64?: string;
  /** Deep-link para abrir directamente la app del wallet (Yape one-shot / afiliación). */
  deepLink?: string;
  /** Código CIP de PagoEfectivo (pago en agente/efectivo). */
  cip?: string;
  /** Caducidad del checkout (ISO) si el proveedor la informa. */
  expiresAt?: string;
}

export interface GatewayChargeResult {
  status: GatewayChargeStatus;
  /** Id de la transacción en el riel (presente si CONFIRMED o PENDING_EXTERNAL — es el uid externo). */
  externalRef?: string;
  /** Motivo del rechazo (presente si DECLINED). */
  reason?: string;
  /**
   * Clase del fallo (presente cuando status=DECLINED). Ausente ⇒ tratar como `declined` (compat: los
   * adapters/consumers viejos que no lo setean no rompen). El dominio lo usa para escribir un
   * failureReason estructurado (`method_unavailable:<METHOD>`) y para que la app degrade honesto
   * por-método en vez del genérico "no pudimos procesar el pago".
   */
  failureKind?: GatewayChargeFailureKind;
  /** Datos de checkout (presentes si PENDING_EXTERNAL y el medio requiere acción del usuario). */
  checkout?: GatewayCheckout;
}

/** Código de error de ProntoPaga: saldo insuficiente en el cobro Yape On File (llega por webhook). */
export const YAPE_INSUFFICIENT_FUNDS_CODE = 'YPTRX002';
/** Razón normalizada que el dominio persiste en el Payment.failureReason para mostrar un recibo honesto. */
export const YAPE_INSUFFICIENT_FUNDS_REASON = 'yape_insufficient_funds';
/** Tope documentado por ProntoPaga para el cobro Yape On File: 2000 PEN por transacción/día. */
export const YAPE_ONFILE_MAX_CENTS = 200_000;

/** Línea de extracto del riel para conciliación (BR-P07). */
export interface GatewayStatementEntry {
  externalRef: string;
  amountCents: number;
}

export interface PaymentGateway {
  /**
   * Flujo de cobro que este adapter implementa (capacidad DECLARADA). El dominio elige el camino
   * (un intento asíncrono vs reintentos síncronos) según ESTO, jamás según `VEO_PAYMENT_MODE`.
   */
  readonly chargeFlow: GatewayChargeFlow;
  /**
   * ¿Este adapter puede cobrar `method`? Capacidad DECLARADA (espejo de supportsRefund/
   * supportsWebhooks): el dominio pregunta al puerto en lugar de adivinar el catálogo por env.
   * La habilitación COMERCIAL real del método se descubre igual en runtime
   * (failureKind=capability_unavailable); esto declara el catálogo que el adapter SABE hablar.
   */
  supports(method: GatewayPaymentMethod): boolean;
  /** Intenta cobrar contra el riel. Un solo intento; el reintento/backoff lo orquesta el dominio. */
  charge(req: GatewayChargeRequest): Promise<GatewayChargeResult>;
  /** Extracto del riel en una ventana [start, end) para conciliar contra lo capturado en DB. */
  getStatement(periodStart: Date, periodEnd: Date): Promise<GatewayStatementEntry[]>;
}

/* ──────────────────────────── Capacidades opcionales (ISP) ──────────────────────────── */

/** Clase del evento de webhook: cobro de un viaje o confirmación de afiliación de wallet. */
export type WebhookKind = 'payment' | 'affiliation';

/** Estado normalizado del webhook (agnóstico del proveedor). */
export type WebhookStatus = 'CONFIRMED' | 'DECLINED' | 'PENDING' | 'EXPIRED';

export interface WebhookResult {
  kind: WebhookKind;
  /** Id externo de la transacción/afiliación en el proveedor (uid). */
  externalId: string;
  /** Nuestra referencia: `order` para pagos (= paymentId), id de afiliación para affiliation. */
  order?: string;
  status: WebhookStatus;
  /** Código de error del proveedor si lo trae (p.ej. YPTRX002 = saldo insuficiente). */
  errorCode?: string;
  /** Payload crudo del proveedor (para auditoría/observabilidad; sin PII completa en logs). */
  raw: Record<string, unknown>;
}

/**
 * Capacidad: el adapter verifica la firma de un webhook entrante y lo normaliza.
 * Firma INVÁLIDA → lanza UnauthorizedError (el controller responde 401 sin detalles).
 */
export interface WebhookVerifier {
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookResult;
}

export interface RefundResult {
  status: 'ACCEPTED' | 'REJECTED' | 'PENDING';
  /** Id del reverso en el proveedor (si lo devuelve síncronamente). */
  externalRefundId?: string;
  reason?: string;
}

/** Metadatos que el proveedor puede exigir para reembolsar (ProntoPaga: clientDocument + callback). */
export interface RefundMeta {
  clientDocument?: string;
  urlCallbackRefund?: string;
  /**
   * Clave de idempotencia del reverso, derivada de la operación de negocio (`refund-{refundId}`,
   * INTEGRACIONES §4) y persistida ANTES de llamar. El adapter la usa si el proveedor soporta
   * idempotencia (sandbox: reverso determinista por key). ProntoPaga NO expone un campo de
   * idempotencia en /reverse/new → ahí la idempotencia la garantiza el dominio (Refund PENDING
   * persistido antes de llamar + claim transaccional; nunca se re-llama a ciegas).
   */
  idempotencyKey?: string;
}

/** Capacidad: el adapter reembolsa una transacción capturada. */
export interface Refundable {
  refund(externalRef: string, amountCents: number, meta?: RefundMeta): Promise<RefundResult>;
}

/**
 * Detalle del estado de un cobro consultado al proveedor por su uid (fallback al webhook).
 * `found=false` cuando el proveedor no reconoce el uid (ProntoPaga devuelve HTTP 200 con
 * `{error:'payment not found.'}` para un uid inexistente — NO un 404).
 */
export interface PaymentStatusDetail {
  /** El proveedor reconoció el uid. Si false, el resto de los campos no aplican. */
  found: boolean;
  /** Estado normalizado del cobro (CONFIRMED→capturado, DECLINED, EXPIRED, PENDING→sigue en curso). */
  status: WebhookStatus;
  /** Estado crudo del proveedor (new|created|pending|success|rejected|expired…) para observabilidad. */
  rawStatus?: string;
}

/**
 * Capacidad: el adapter consulta el estado de un cobro por su uid (PULL).
 * Habilita el POLL FALLBACK cuando el webhook no llega (p.ej. localhost sin túnel): el dominio
 * pregunta el estado y lo aplica por el MISMO camino idempotente que el webhook (applyWebhookResult).
 */
export interface PaymentStatusQuery {
  getPaymentStatus(externalUid: string): Promise<PaymentStatusDetail>;
}

/** Resultado de crear una afiliación Yape On File (datos para el cliente + uid server-side). */
export interface YapeSubscriptionResult {
  /** UID de la afiliación en el proveedor (= walletUID; SOLO server-side; NUNCA sale en DTOs). */
  uid?: string;
  /** Estado inicial reportado por el proveedor (PROCESS|EXPIRED|...). */
  status?: string;
  /** Deep-link para que el cliente abra Yape y APRUEBE la afiliación (SÍ va al cliente). */
  deepLink?: string;
  /** Teléfono que el proveedor eco-devuelve (null en MOBILE hasta la aceptación). */
  phoneNumber?: string | null;
}

/** Detalle de una suscripción Yape consultada por /show (status real + phoneNumber al aceptar). */
export interface YapeSubscriptionDetail {
  uid?: string;
  /** PROCESS | ACCEPTED | EXPIRED | ... según el proveedor. */
  status?: string;
  /** Teléfono Yape: viene poblado cuando la suscripción está ACCEPTED. */
  phoneNumber?: string | null;
}

/**
 * Capacidad: el adapter gestiona afiliaciones de wallet (Yape On File).
 * `phoneNumber` se OMITE en origin=MOBILE (el deepLink abre Yape directo) y solo se envía en origin=WEB.
 */
export interface YapeSubscriber {
  createYapeSubscription(input: {
    origin: 'WEB' | 'MOBILE';
    document: string;
    clientDocumentType: 'DN' | 'CE' | 'PP';
    /** Solo se manda en origin=WEB; en MOBILE se omite (deepLink abre la app Yape). */
    phoneNumber?: string;
    clientName: string;
    type: 'RECURRENT' | 'ON_DEMAND';
  }): Promise<YapeSubscriptionResult>;

  /** Consulta el estado real de la suscripción (fallback al webhook no documentado). */
  showYapeSubscription(walletUid: string): Promise<YapeSubscriptionDetail>;

  /** Cancela la afiliación en el proveedor (POST .../cancel/{walletUID}). */
  cancelYapeSubscription(walletUid: string): Promise<void>;
}

/** Type-guard: ¿este adapter verifica webhooks? */
export function supportsWebhooks(g: PaymentGateway): g is PaymentGateway & WebhookVerifier {
  return typeof (g as Partial<WebhookVerifier>).verifyWebhook === 'function';
}

/** Type-guard: ¿este adapter crea afiliaciones Yape? */
export function supportsYapeSubscription(g: PaymentGateway): g is PaymentGateway & YapeSubscriber {
  return typeof (g as Partial<YapeSubscriber>).createYapeSubscription === 'function';
}

/** Type-guard: ¿este adapter reembolsa? */
export function supportsRefund(g: PaymentGateway): g is PaymentGateway & Refundable {
  return typeof (g as Partial<Refundable>).refund === 'function';
}

/** Type-guard: ¿este adapter consulta el estado de un cobro por uid (poll fallback)? */
export function supportsStatusQuery(g: PaymentGateway): g is PaymentGateway & PaymentStatusQuery {
  return typeof (g as Partial<PaymentStatusQuery>).getPaymentStatus === 'function';
}
