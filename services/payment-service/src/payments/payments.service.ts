/**
 * PaymentsService — cobros idempotentes, comisión, reintentos→DEBT, efectivo bilateral y reembolsos.
 * BR-P01..P04, P06. El dinero SIEMPRE en céntimos PEN. Eventos vía OUTBOX (misma transacción).
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createEnvelope } from '@veo/events';
import { deletedPlaceholder, isUniqueViolation } from '@veo/database';
import {
  assertNever,
  ConcurrencyConflictError,
  ConflictError,
  ForbiddenError,
  InvalidStateError,
  NotFoundError,
  UnprocessableEntityError,
  uuidv7,
} from '@veo/utils';
import type { PaymentMethod } from '@veo/shared-types';
import { AdminRole } from '@veo/shared-types';
import type { AuthenticatedUser } from '@veo/auth';
import {
  PaymentsRepository,
  type PaymentTx,
  type RefundWithPayment,
} from './payments.repository';
import { CreditService } from '../credit/credit.service';
import {
  PAYMENT_GATEWAY,
  supportsRefund,
  type PaymentGateway,
  type GatewayChargeResult,
  type RefundResult,
  type WebhookStatus,
  YAPE_ONFILE_MAX_CENTS,
  YAPE_INSUFFICIENT_FUNDS_CODE,
  YAPE_INSUFFICIENT_FUNDS_REASON,
} from '../ports/gateway/payment-gateway.port';
import { AffiliationsService } from '../affiliations/affiliations.service';
import { PromotionsService } from '../promotions/promotions.service';
import { RefundStatus, type Payment, type Refund } from '../generated/prisma';
import {
  assertCanAddTip,
  assertPaymentTransition,
  assertRefundTransition,
  BOOKING_CANCEL_REFUND_DEDUP_PREFIX,
  bpsToRate,
  ChargeMode,
  computeChargeAmounts,
  computePspSettlement,
  DEFAULT_DIGITAL_TIP_METHOD,
  deriveAdminRefundDedupKey,
  deriveBookingCancellationRefundDedupKey,
  deriveRefundIdempotencyKey,
  deriveTipChargeDedupKey,
  deriveTipRefundDedupKey,
  isCashMethod,
  isSettledPayment,
  retryDelayMs,
} from './payment.policy';
import { CommissionService } from '../commission/commission.service';
import { PaymentMetrics } from '../metrics/payment.metrics';
import { zonifyLima } from '../analytics/zonify';
import type { Env } from '../config/env.schema';
import type { DebtItem, DebtSummary } from './dto/payments.dto';

/**
 * Prefijo de la razón ESTRUCTURADA que el dominio persiste en Payment.failureReason cuando un cobro cae
 * a DEBT porque el MÉTODO no está habilitado en el comercio (ProntoPaga 400 "not enabled for commerce",
 * clasificado por el adapter como failureKind=capability_unavailable). Formato `method_unavailable:<METHOD>`
 * (p.ej. `method_unavailable:PAGOEFECTIVO`). El BFF/app lo parsean para decir "PagoEfectivo no está
 * disponible ahora, elegí otro método" en vez del genérico "no pudimos procesar el pago".
 */
export const METHOD_UNAVAILABLE_PREFIX = 'method_unavailable';

/** Construye la razón estructurada `method_unavailable:<METHOD>` para un cobro a DEBT por capability. */
function methodUnavailableReason(method: PaymentMethod): string {
  return `${METHOD_UNAVAILABLE_PREFIX}:${method}`;
}

/**
 * Prefijo de la razón ESTRUCTURADA del MARCADOR DURABLE de un refund system-initiated IRRECUPERABLE:
 * el refund automático abortó ANTES de mover plata (gateway sin reembolsos / cobro sin railRef) → NO hay
 * Refund row. Persistimos un Refund REJECTED de marca (cero strings mágicos: `unrecoverable:<causa>`) para
 * que el INVARIANTE SAGRADO se cumpla — el pasajero NUNCA queda sin refund Y sin traza durable: el admin lo
 * ve en la lista de Refunds REJECTED (status=REJECTED + failureReason con este prefijo) y lo resuelve a mano.
 */
export const UNRECOVERABLE_REFUND_FAILURE_PREFIX = 'unrecoverable:';

export interface ChargeInput {
  tripId: string;
  grossCents: number;
  tipCents?: number;
  method: PaymentMethod;
  payerRef?: string;
  driverId?: string;
  dedupKey: string;
  /**
   * MODO del cobro (F2.7 · ADR-017 §1.6 / ADR-015 §11.2): determina la TASA y el MODELO de comisión. ON_DEMAND →
   * comisión DESCONTADA al conductor (tasa configurable, `grossCents` = la tarifa); CARPOOLING → service fee
   * SUMADO al pasajero (fee configurable, `grossCents` = la CONTRIBUCIÓN del conductor → el bruto cobrado = contribución
   * + fee). Lo SETEA el caller en el PUNTO DE ENTRADA del cobro (el consumer trip.completed → ON_DEMAND; el
   * controller charge service-rail → CARPOOLING). Opcional por compat: ausente ⇒ ON_DEMAND, NUNCA CARPOOLING por defecto.
   */
  mode?: ChargeMode;
  /** Código de promoción opcional (Ola 2A). Se canjea y descuenta del total del pasajero. */
  promoCode?: string;
  /** Id del pasajero que paga (necesario para canjear la promo y resolver afiliación on-file). */
  userId?: string;
  /** MÉTRICAS · modo de despacho del viaje (FIXED/PUJA) denormalizado del evento — divide el ON_DEMAND en
   *  Fijo/Puja para el corte "Ingresos por modo". Ausente ⇒ null. */
  dispatchMode?: string;
  /** MÉTRICAS · origen del viaje (lat/lng) denormalizado del evento — se zonifica a distrito en la captura. */
  originLat?: number;
  originLng?: number;
  /**
   * Datos del cliente exigidos por el agregador (ProntoPaga: nombre/email/doc en /payment/new).
   * Opcional: solo lo usa el modo prontopaga; el resto lo ignora. PII mínima, no se persiste acá.
   */
  client?: {
    name?: string;
    email?: string;
    phone?: string;
    document?: string;
    documentType?: 'DN' | 'CE' | 'PP';
  };
}

/**
 * Marcador TIPADO del actor de un refund SYSTEM-INITIATED (F3c-payment): el refund automático por
 * `booking.cancelled` NO lo dispara un humano — lo dispara el sistema con autoridad total (no discrecional),
 * así que NO valida rol L2 ni ventana. Se persiste como `requestedBy`/`approvedBy` del Refund y viaja como
 * `approvedBy` en `payment.refunded`. Const tipado, NO un string mágico suelto regado por el código.
 */
export const SYSTEM_OPERATOR = 'system' as const;

/**
 * Reserva de reembolso ya VALIDADA por el caller: montos + transición destino del Payment (S5). El actor se
 * desacopla del `AuthenticatedUser` humano (`requestedBy`/`approvedBy` ya resueltos a string) para que el
 * MISMO core de refund sirva al refund ADMIN (operador humano) y al SYSTEM-INITIATED (F3c, sin operador).
 * `dedupKey` (opcional) es la barrera DURA de idempotencia del refund automático (UNIQUE en `Refund.dedupKey`);
 * NULL en los refunds admin discrecionales.
 */
interface RefundClaim {
  amountCents: number;
  reason: string;
  /** Quién PIDIÓ el refund (userId del operador humano, o SYSTEM_OPERATOR para el automático). */
  requestedBy: string;
  /** Quién lo APROBÓ (igual al requestedBy salvo flujos con aprobador distinto). Va en payment.refunded. */
  approvedBy: string;
  /** Idempotencia DURA del refund system-initiated (UNIQUE). NULL en refunds admin discrecionales. */
  dedupKey: string | null;
  newStatus: 'REFUNDED' | 'PARTIALLY_REFUNDED';
  newRefundedCents: number;
  isFullyRefunded: boolean;
  /**
   * RC18 (ADR-022) · Causa ATRIBUIBLE al conductor (viaje no realizado / fraude del conductor). Solo entonces un
   * refund TOTAL de una tarifa digital genera el clawback del neto del conductor (DriverDebt REFUND_CLAWBACK). El
   * default (false) = lo absorbe la plataforma (dispute/fraude del pasajero). El system-initiated (booking cancel)
   * es SIEMPRE false (no es culpa del conductor). Se persiste en el Refund y lo lee `completeRefund` al confirmar.
   */
  clawbackDriver: boolean;
  /**
   * Aplica el backstop server-side de idempotencia por VENTANA TEMPORAL sobre (paymentId, céntimos) ANTES de
   * crear el refund (solo el camino ADMIN discrecional). El system-initiated NO lo lleva (tiene su `dedupKey`
   * determinista por bookingId). `false`/undefined = sin backstop de ventana (el operador pidió `forceNew`, o es
   * system-initiated).
   */
  enforceWindowDedup?: boolean;
  /**
   * Cola de aprobación (money-OUT · frame HZ8uz): id de una solicitud de reembolso YA existente en estado PENDING
   * que este desembolso MATERIALIZA (aprobación del operador). Con él, el core NO crea una fila nueva: transiciona
   * la solicitud PENDING → APPROVED/COMPLETED por CAS. AUSENTE ⇒ refund AUTO (system-initiated / propina revertida):
   * el core CREA la fila directamente en APPROVED/COMPLETED (auto-aprobado, sin pasar por la cola).
   */
  existingRefundId?: string;
}

/**
 * Señal de control INTERNA (nunca cruza el borde del servicio): el backstop de ventana encontró un reembolso
 * reciente del MISMO dinero (paymentId, céntimos) → `refund()` la atrapa y devuelve el existente idempotentemente,
 * sin doble-pagar. Lleva el refund ya creado para el retorno.
 */
class DuplicateRefundInWindowError extends Error {
  constructor(readonly existing: { refundId: string; paymentId: string; status: string }) {
    super('Ya existe un reembolso reciente para este pago y monto (ventana de idempotencia)');
    this.name = 'DuplicateRefundInWindowError';
  }
}

/** Desglose real de ganancias de un conductor en una ventana temporal (BR-P05). Céntimos PEN. */
export interface DriverEarningsBreakdown {
  grossCents: number;
  commissionCents: number;
  tipCents: number;
  netCents: number;
  /** Neto de cobros CASH: lo que el conductor ya tiene EN MANO (su comisión queda como deuda a netear). */
  cashNetCents: number;
  /** Neto de cobros DIGITALES (+ propinas, siempre digitales): lo que le cae por liquidación (payout). */
  digitalNetCents: number;
  tripCount: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly commissionRate: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly defaultMethod: PaymentMethod;
  private readonly refundWindowDays: number;
  private readonly refundHighValueThresholdCents: number;
  private readonly refundIdempotencyWindowMs: number;
  private readonly cancellationDriverShare: number;

  constructor(
    private readonly repo: PaymentsRepository,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly affiliations: AffiliationsService,
    private readonly promotions: PromotionsService,
    config: ConfigService<Env, true>,
    // Opcional: lo PROVEE PaymentsModule por DI (redención de crédito de referido · Ola 2A · Lote B).
    // Trailing + @Optional para no romper los call-sites de test que construyen el service con 5 args;
    // si no está inyectado, el cobro simplemente no aplica crédito (saldo intacto).
    @Optional() private readonly credit?: CreditService,
    // Métricas Prometheus (CoreModule @Global → SIEMPRE inyectable en runtime). @Optional + trailing por la
    // MISMA razón que `credit`: los specs construyen el service a mano con menos args. La métrica de backstop de
    // refunds (`payment_refund_backstop_total`) se emite acá (riel común de rechazo de refund), no solo en el
    // consumer Kafka — así cubre TAMBIÉN el rechazo ASÍNCRONO por callback del proveedor (applyRefundWebhookResult).
    @Optional() private readonly metrics?: PaymentMetrics,
    // F2.7 · resuelve la tasa de comisión por MODO (ON_DEMAND configurable · CARPOOLING 0 legal-gated). @Optional
    // + trailing por la MISMA razón que credit/metrics: los specs construyen el service a mano con menos args. Si
    // NO está inyectado, el cobro cae a `this.commissionRate` del env (degradación honesta) y trata todo como
    // ON_DEMAND — JAMÁS rompe el cobro por falta de la config.
    @Optional() private readonly commission?: CommissionService,
  ) {
    this.commissionRate = config.getOrThrow<number>('COMMISSION_RATE');
    this.maxRetries = config.getOrThrow<number>('PAYMENT_MAX_RETRIES');
    this.retryBaseMs = config.getOrThrow<number>('PAYMENT_RETRY_BASE_MS');
    this.defaultMethod = config.getOrThrow<PaymentMethod>('DEFAULT_PAYMENT_METHOD');
    this.refundWindowDays = config.getOrThrow<number>('REFUND_WINDOW_DAYS');
    this.refundHighValueThresholdCents = config.getOrThrow<number>('REFUND_L2_THRESHOLD_CENTS');
    this.refundIdempotencyWindowMs =
      config.getOrThrow<number>('REFUND_IDEMPOTENCY_WINDOW_MINUTES') * 60_000;
    this.cancellationDriverShare = config.getOrThrow<number>('CANCELLATION_DRIVER_SHARE');
  }

  /**
   * Guard método×capacidad (compartido por charge y settleCancellationPenalty): un método DIGITAL
   * solo se cobra si el ADAPTER activo lo DECLARA en su catálogo (`gateway.supports`). Antes era un
   * check contra el modo del env DUPLICADO verbatim en ambos llamadores; ahora la capacidad la
   * declara el puerto y el dominio pregunta — agregar un proveedor NO toca este service.
   * CASH no pasa por el gateway (confirmación bilateral, BR-P03) → acá no se valida.
   */
  private assertGatewaySupportsMethod(method: PaymentMethod): void {
    if (method === 'CASH') return;
    if (!this.gateway.supports(method)) {
      throw new InvalidStateError(
        `El cobro con ${method} no está habilitado en el gateway de pagos activo; elegí otro método`,
      );
    }
  }

  /**
   * F2.7 · Resuelve la TASA de comisión (fracción 0..1 que consume `commission()`) para un MODO de cobro.
   * ON_DEMAND → `onDemandRateBps` (comisión descontada al conductor); CARPOOLING → `carpoolingFeeBps` (service
   * fee sumado al pasajero) — ambas de CommissionConfig (bps Int → fracción al aplicar). DEGRADACIÓN HONESTA: sin
   * CommissionService inyectado (DI ausente en tests) el on-demand cae a `this.commissionRate` del env y el
   * carpooling cae a 0 (sin fee) — NUNCA rompe el cobro por falta de la config. La tasa SIEMPRE nace como bps Int;
   * el float solo aparece acá, al APLICARLA (redondeo a céntimo Int en `commission()`).
   */
  // DEUDA: MEMBRESÍAS (ADR-022 §P-E conductor + §P-F pasajero). Diferidas a propósito — primero que TODO el flujo
  //   actual funcione end-to-end; las membresías son features de negocio NUEVOS, se construyen sobre base sólida.
  //   Cuando se retomen, ESTE es el único seam a tocar (lo dice el ADR): threadear `driverId` acá →
  //   `resolveRateBps(mode, driverId)` → `resolveCommissionBps(mode, config, driverOverrideBps?)`. Diseño cerrado:
  //   P-E = DriverCommissionPlan { driverId, planTier(FREE|PRO|PRO_PLUS), onDemandDiscountBps, activeUntil },
  //   tiers % reducido (Free 12% → Pro 8% → Pro+ 6%, relativo a la base ADR-017, piso 0%), GATED a ON_DEMAND,
  //   billing Yape On-File recurrente. Sin plan activo → cae al CommissionConfig global (cero cambio = FREE).
  //   P-F (pasajero) = cashback/prioridad/descuento vía CreditService/discountCents; depende de P-H (carpool UI).
  private async resolveChargeRate(mode: ChargeMode): Promise<number> {
    if (!this.commission) {
      // DI ausente (tests/degradación): on-demand → la tasa del env; carpooling → 0 (sin service fee).
      return mode === ChargeMode.CARPOOLING ? bpsToRate(0) : this.commissionRate;
    }
    return bpsToRate(await this.commission.resolveRateBps(mode));
  }

  /**
   * Despacho POLIMÓRFICO del cobro digital según el flujo que el ADAPTER declara (`chargeFlow`),
   * jamás según el env: 'aggregator' → un intento asíncrono (checkout + webhook/poll cierran el
   * Payment); 'direct' → riel síncrono con reintentos y backoff (BR-P02). Switch EXHAUSTIVO sin
   * default silencioso: un flujo nuevo en el puerto OBLIGA a decidir acá (assertNever).
   */
  private dispatchDigitalCharge(payment: Payment, input: ChargeInput): Promise<Payment> {
    const flow = this.gateway.chargeFlow;
    switch (flow) {
      case 'aggregator':
        return this.processAggregatorCharge(payment, input);
      case 'direct':
        return this.processGatewayCharge(payment);
      default:
        return assertNever(flow, 'GatewayChargeFlow no contemplado');
    }
  }

  /**
   * Cobro idempotente (BR-P01/P04 + idempotencia). Segundo intento con la misma dedupKey
   * devuelve el MISMO pago sin recobrar. Yape/Plin se procesan contra el riel con reintentos→DEBT;
   * el efectivo queda PENDING hasta la confirmación bilateral (BR-P03).
   */
  async charge(input: ChargeInput): Promise<Payment> {
    // Un método digital solo si el adapter activo lo declara (p.ej. el riel directo Yape/Plin no
    // cobra CARD/PAGOEFECTIVO — eso lo habla el agregador).
    this.assertGatewaySupportsMethod(input.method);

    const existing = await this.repo.findPaymentByDedupKey(input.dedupKey);
    if (existing) return existing;

    // Promo (Ola 2A): canje idempotente derivado de la dedupKey del cobro. El descuento reduce SOLO
    // lo que paga el pasajero; la comisión (sobre el bruto) y la propina quedan intactas. Si la promo
    // no aplica/expiró/agotó, redeemPromo lanza un DomainError claro y el cobro no se realiza.
    let discountCents = 0;
    if (input.promoCode && input.userId) {
      const redemption = await this.promotions.redeemPromo({
        code: input.promoCode,
        userId: input.userId,
        tripId: input.tripId,
        fareCents: input.grossCents,
        dedupKey: `promo:${input.dedupKey}`,
      });
      discountCents = redemption.discountCents;
    }

    // Crédito de referido (Ola 2A · Lote B): se aplica DESPUÉS de la promo, sobre la tarifa RESTANTE
    // (gross − promo), NUNCA sobre la propina (esa es del conductor, la paga el pasajero). Mismo trato
    // financiero que la promo: reduce lo que paga el pasajero, la plataforma lo absorbe (comisión sobre el
    // bruto). Idempotente por `credit:dedupKey`; si el Payment ya existía cortamos en `existing` arriba, así
    // el crédito se gasta UNA sola vez. `this.credit` es opcional (DI) → sin él, el cobro no aplica crédito.
    let creditCents = 0;
    if (input.userId && this.credit) {
      const maxCreditCents = Math.max(0, input.grossCents - discountCents);
      creditCents = await this.credit.spendForCharge({
        userId: input.userId,
        maxApplicableCents: maxCreditCents,
        chargeDedupKey: input.dedupKey,
      });
    }

    // F2.7 · la TASA y el MODELO de comisión se resuelven por MODO (NO global): ON_DEMAND → comisión
    // DESCONTADA al conductor (tasa configurable); CARPOOLING → service fee SUMADO al pasajero (fee configurable).
    // Para carpooling, `input.grossCents` es la CONTRIBUCIÓN del conductor; `computeChargeAmounts` deriva el bruto
    // COBRADO al pasajero (= contribución + fee) y lo persiste en `amounts.grossCents`. Ver `computeChargeAmounts`.
    const mode = input.mode ?? ChargeMode.ON_DEMAND;
    const rate = await this.resolveChargeRate(mode);

    const amounts = computeChargeAmounts(
      mode,
      input.grossCents,
      input.tipCents ?? 0,
      rate,
      discountCents + creditCents,
    );

    let payment: Payment;
    try {
      payment = await this.repo.createPayment({
        id: uuidv7(),
        tripId: input.tripId,
        driverId: input.driverId ?? null,
        // Pasajero del viaje (lo trae el trip.completed): se persiste para enriquecer
        // payment.captured / payment.refunded → push al pasajero (sin join cross-servicio).
        passengerId: input.userId ?? null,
        dedupKey: input.dedupKey,
        amountCents: amounts.amountCents,
        grossCents: amounts.grossCents,
        // discountCents = SOLO promo; creditCents = SOLO crédito de referido (reconciliación separada).
        // amounts.discountCents es la suma (promo+crédito) que se descontó del payable; los guardamos
        // partidos. amountCents = gross − discountCents − creditCents + tip (invariante del modelo).
        discountCents,
        creditCents,
        tipCents: amounts.tipCents,
        commissionCents: amounts.commissionCents,
        feeCents: amounts.feeCents,
        method: input.method,
        mode,
        // MÉTRICAS · denorm para los cortes por modo/distrito del panel. dispatchMode divide el ON_DEMAND en
        // Fijo/Puja; el distrito se ZONIFICA del origen ACÁ (una vez, en la captura) y se persiste para agregar
        // sin re-zonificar. Nullable honesto: cobro sin geo o fuera de cobertura → distrito null (no se inventa).
        dispatchMode: input.dispatchMode ?? null,
        originLat: input.originLat ?? null,
        originLng: input.originLng ?? null,
        district: zonifyLima(input.originLat, input.originLng),
        payerRef: input.payerRef ?? null,
        status: 'PENDING',
      });
    } catch (err) {
      // Carrera de doble-submit con la misma dedupKey: el UNIQUE garantiza un solo pago.
      if (isUniqueViolation(err, 'dedupKey')) {
        const dup = await this.repo.findPaymentByDedupKey(input.dedupKey);
        if (dup) return dup;
        throw new ConflictError('Cobro duplicado para la misma dedupKey');
      }
      throw err;
    }

    if (input.method === 'CASH') {
      // El efectivo se captura con la confirmación bilateral (BR-P03), no contra el riel.
      return payment;
    }

    // Cobro digital: el flujo lo DECLARA el adapter (aggregator asíncrono / riel directo con
    // reintentos, BR-P02). El env que elige el adapter solo lo mira la factory, nunca este service.
    return this.dispatchDigitalCharge(payment, input);
  }

  /**
   * Cobro vía agregador (ProntoPaga): un solo `charge`. Resultados:
   *  - PENDING_EXTERNAL → persistimos checkout (urlPay/qr/deepLink/cip/uid) y el Payment queda PENDING.
   *                       La captura llega por webhook (applyWebhookResult). YAPE con afiliación ACTIVE
   *                       se cobra ON-FILE (sin checkout) → PENDING → webhook captura.
   *  - CONFIRMED        → captura inmediata (algunos métodos podrían confirmar síncrono).
   *  - DECLINED         → DEBT (mismo trato que el riel directo).
   */
  private async processAggregatorCharge(payment: Payment, input: ChargeInput): Promise<Payment> {
    const method = payment.method as Extract<
      PaymentMethod,
      'YAPE' | 'PLIN' | 'CARD' | 'PAGOEFECTIVO'
    >;

    // YAPE con afiliación ACTIVE → cobro on-file (server-initiated). Resolvemos el walletUid server-side
    // (NUNCA viaja en el request del cliente). Sin afiliación, YAPE cae a QR.
    let walletUid: string | undefined;
    if (method === 'YAPE' && input.userId) {
      walletUid = (await this.affiliations.resolveActiveWalletUid(input.userId)) ?? undefined;
    }

    // Tope de Yape On File: 2000 PEN/transacción (doc ProntoPaga). Por encima del tope NO intentamos el
    // cobro on-file (el proveedor lo rechazaría): degradamos a checkout QR (omitimos el walletUid) con log.
    if (walletUid && payment.amountCents > YAPE_ONFILE_MAX_CENTS) {
      this.logger.warn(
        `Cobro on-file por encima del tope Yape (${payment.amountCents}c > ${YAPE_ONFILE_MAX_CENTS}c) pago=${payment.id}: degradando a QR`,
      );
      walletUid = undefined;
    }

    let result: GatewayChargeResult;
    try {
      result = await this.gateway.charge({
        paymentId: payment.id,
        tripId: payment.tripId,
        amountCents: payment.amountCents,
        method,
        payerRef: payment.payerRef ?? undefined,
        walletUid,
        client: input.client,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'gateway_error';
      this.logger.warn(`Cobro agregador falló (excepción) pago=${payment.id}: ${reason}`);
      return this.markDebt(payment, reason);
    }

    if (result.status === 'CONFIRMED') {
      return this.captureSuccess(payment, result.externalRef ?? null, 1);
    }
    if (result.status === 'DECLINED') {
      // capability_unavailable → razón ESTRUCTURADA `method_unavailable:<METHOD>` (no el reason crudo del
      // proveedor): el Payment cae a DEBT pero la app sabe QUÉ método falló y puede sugerir otro, en vez
      // del genérico "no pudimos procesar el pago". Un decline normal conserva el reason del riel.
      const reason =
        result.failureKind === 'capability_unavailable'
          ? methodUnavailableReason(method)
          : (result.reason ?? 'declined');
      return this.markDebt(payment, reason);
    }

    // PENDING_EXTERNAL: persistir checkout; el Payment queda PENDING hasta el webhook.
    const updated = await this.repo.persistAggregatorCheckout(payment.id, {
      externalUid: result.externalRef ?? null,
      checkoutUrl: result.checkout?.urlPay ?? null,
      qrCode: result.checkout?.qrCodeBase64 ?? null,
      deepLink: result.checkout?.deepLink ?? null,
      cip: result.checkout?.cip ?? null,
      checkoutExpiresAt: result.checkout?.expiresAt ? new Date(result.checkout.expiresAt) : null,
    });
    this.logger.log(
      `Cobro agregador PENDIENTE pago=${payment.id} uid=${result.externalRef ?? '-'} (espera webhook)`,
    );
    return updated;
  }

  /** Reintenta el cobro contra el riel hasta `maxRetries`; captura o cae en DEBT. */
  private async processGatewayCharge(payment: Payment): Promise<Payment> {
    const method = payment.method as Extract<PaymentMethod, 'YAPE' | 'PLIN'>;
    let lastReason = 'unknown';

    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 1) await sleep(retryDelayMs(attempt, this.retryBaseMs));
      let result;
      try {
        result = await this.gateway.charge({
          paymentId: payment.id,
          tripId: payment.tripId,
          amountCents: payment.amountCents,
          method,
          payerRef: payment.payerRef ?? undefined,
        });
      } catch (err) {
        lastReason = err instanceof Error ? err.message : 'gateway_error';
        this.logger.warn(
          `Intento ${attempt}/${this.maxRetries} falló (excepción) pago=${payment.id}: ${lastReason}`,
        );
        continue;
      }

      if (result.status === 'CONFIRMED') {
        return this.captureSuccess(payment, result.externalRef ?? null, attempt);
      }
      // capability_unavailable: reintentar el MISMO método es inútil (no está habilitado en el comercio).
      // Cortamos el bucle YA y caemos a DEBT con la razón estructurada por-método.
      if (result.failureKind === 'capability_unavailable') {
        this.logger.warn(
          `Método ${method} no habilitado (capability) pago=${payment.id}: no se reintenta`,
        );
        return this.markDebt(payment, methodUnavailableReason(method));
      }
      lastReason = result.reason ?? 'declined';
      this.logger.warn(
        `Intento ${attempt}/${this.maxRetries} declinado pago=${payment.id}: ${lastReason}`,
      );
    }

    // Los 3 intentos fallaron → DEBT + payment.failed willRetry=false (bloqueo + alerta).
    return this.markDebt(payment, lastReason);
  }

  private async captureSuccess(
    payment: Payment,
    externalRef: string | null,
    attempts: number,
  ): Promise<Payment> {
    assertPaymentTransition(payment.status, 'CAPTURED');
    // P-B · el PSP (ProntoPaga) descuenta su fee ANTES de depositar → el bruto (amountCents) NO es lo que la
    // plataforma recibe. Modelamos el fee al capturar (por método, editable por admin; 0 si no seteado o sin
    // CommissionService) para persistir el NETO REAL que llega al banco. Se computa fuera de la tx (lectura cacheada).
    const feeBps = (await this.commission?.resolvePspFeeBps?.(payment.method)) ?? 0;
    const { pspFeeCents, netSettledCents } = computePspSettlement(payment.amountCents, feeBps);
    return this.repo.runInTransaction(async (tx) => {
      // CAS atómico: el estado va en el WHERE (invariante en el repo). Dos entregas del webhook procesadas EN
      // PARALELO leen ambas PENDING (TOCTOU en applyWebhookResult: read en 688 + check en 696); solo la que
      // matchea PENDING→CAPTURED emite payment.captured y colecta la penalidad. La perdedora ve count=0 →
      // devuelve el pago ya capturado SIN duplicar el evento (espeja el guard de collectPenaltyInTx).
      //
      // El CAS (en el repo) incluye DEBT y FAILED además de PENDING: un cobro que cayó a DEBT (declive/reintentos
      // agotados) o a FAILED (checkout expirado/cancelado) y LUEGO el PSP confirma (webhook CONFIRMED tardío) DEBE
      // capturar — la plata SE MOVIÓ. PENDING/DEBT/FAILED → CAPTURED son todas transiciones válidas (payment.policy).
      // El guard idempotente (status===CAPTURED/REFUNDED) ya corta antes en el caller; acá el CAS serializa el resto
      // → CAPTURED (una sola captura gana; el que ve count=0 devuelve el ya-capturado).
      const { count } = await this.repo.casCapturePayment(tx, payment.id, {
        status: 'CAPTURED',
        externalRef,
        retries: attempts,
        capturedAt: new Date(),
        failureReason: null,
        pspFeeCents,
        netSettledCents,
      });
      const updated = await this.repo.findPaymentByIdInTx(tx, payment.id);
      if (count === 0) return updated; // otra entrega ya capturó: no re-emitir ni re-colectar
      // A1 · un tip-Payment (kind=TIP) que captura NO es un "pago del viaje": emite `payment.tip_added` (el
      // conductor cobra la propina SOLO cuando se cobró de verdad + entra al payout), no `payment.captured`.
      const envelope =
        updated.kind === 'TIP'
          ? createEnvelope({
              eventType: 'payment.tip_added',
              producer: 'payment-service',
              payload: {
                paymentId: updated.id,
                tripId: updated.tripId,
                driverId: updated.driverId ?? undefined,
                tipCents: updated.tipCents,
              },
            })
          : createEnvelope({
              eventType: 'payment.captured',
              producer: 'payment-service',
              payload: {
                paymentId: updated.id,
                tripId: updated.tripId,
                method: updated.method,
                grossCents: updated.grossCents,
                commissionCents: updated.commissionCents,
                // ENRIQUECIDO: push "pago confirmado · S/X.XX" al pasajero (notification-service).
                passengerId: updated.passengerId ?? undefined,
              },
            });
      await this.repo.enqueueOutbox(tx, envelope, updated.id);
      // F2.3 · si este Payment SALDA una penalidad de cancelación, flippearla → COLLECTED en la MISMA
      // transacción de captura (vale tanto para el camino sync como para el webhook: ambos pasan por acá).
      if (updated.cancellationPenaltyId) {
        await this.collectPenaltyInTx(tx, updated.cancellationPenaltyId, updated.id);
      }
      return updated;
    });
  }

  /**
   * F2.3 · Marca COLLECTED la penalidad que saldó un Payment de liquidación, DENTRO de la transacción de
   * captura. Idempotente y concurrencia-seguro por status-guard (updateMany where status=PENDING): una
   * redelivery del webhook o una doble-captura NO emite un segundo evento ni re-acredita al conductor. Al
   * flippear emite `payment.cancellation_penalty_collected` (libera el gate de deuda + alimenta el payout
   * del conductor vía collectEarnings). Si la penalidad ya no está PENDING (COLLECTED/WAIVED) → no-op.
   */
  private async collectPenaltyInTx(
    tx: PaymentTx,
    penaltyId: string,
    settlementPaymentId: string,
  ): Promise<void> {
    const claimed = await this.repo.casCollectPenalty(tx, penaltyId);
    if (claimed.count === 0) return; // ya COLLECTED/WAIVED → idempotente, sin segundo evento.
    const penalty = await this.repo.findPenaltyByIdInTx(tx, penaltyId);
    if (!penalty) return;
    const envelope = createEnvelope({
      eventType: 'payment.cancellation_penalty_collected',
      producer: 'payment-service',
      payload: {
        penaltyId: penalty.id,
        tripId: penalty.tripId,
        passengerId: penalty.passengerId,
        driverId: penalty.driverId ?? undefined,
        penaltyCents: penalty.penaltyCents,
        driverCompensationCents: penalty.driverCompensationCents,
        platformCents: penalty.platformCents,
        settlementPaymentId,
      },
    });
    await this.repo.enqueueOutbox(tx, envelope, penalty.id);
  }

  private async markDebt(payment: Payment, reason: string): Promise<Payment> {
    // A1 · una PROPINA (kind=TIP) que declina NO es deuda del viaje ni una falla de cobro que deba escalar:
    // se marca FAILED (terminal) SIN emitir `payment.failed` — ese evento dispara alerta a la central de
    // seguridad + push "pago falló" + bloqueo de nuevos viajes, todo INDEBIDO para una propina OPCIONAL. El
    // pasajero reintenta la propina desde su UI (nueva dedupKey → nuevo tip-Payment).
    if (payment.kind === 'TIP') {
      assertPaymentTransition(payment.status, 'FAILED');
      // RC19 (ADR-022) · el CAS de status vive en el repo: `markTipFailed` ahora es un updateMany
      // `where status ∈ [PENDING,DEBT]` + re-read. Si un webhook CONFIRMED concurrente ya capturó (CAPTURED),
      // el updateMany no matchea → NO lo pisamos; devuelve el estado real (la captura gana), sin emitir
      // `payment.failed`. El desenlace terminal de la propina no cambia (sin evento de falla).
      return this.repo.markTipFailed(payment.id, {
        status: 'FAILED',
        retries: this.maxRetries,
        failureReason: reason,
      });
    }
    assertPaymentTransition(payment.status, 'DEBT');
    return this.repo.runInTransaction(async (tx) => {
      // RC19 (ADR-022) · el CAS de status vive en el repo: `markPaymentDebtInTx` es un updateMany `where status=
      // 'PENDING'` + re-read. Si un CONFIRMED concurrente ya capturó (CAPTURED) en la ventana TOCTOU, el CAS no
      // matchea → la fila releída NO queda en DEBT → NO emitimos `payment.failed` (sería una "falla" FALSA sobre
      // plata ya cobrada, que alertaría a seguridad + bloquearía viajes indebidamente). Espeja el CAS de captureSuccess.
      const updated = await this.repo.markPaymentDebtInTx(tx, payment.id, {
        status: 'DEBT',
        retries: this.maxRetries,
        failureReason: reason,
      });
      if (updated.status !== 'DEBT') return updated; // otra transición ganó la carrera: no re-emitir sobre un estado ajeno
      const envelope = createEnvelope({
        eventType: 'payment.failed',
        producer: 'payment-service',
        payload: {
          paymentId: updated.id,
          tripId: updated.tripId,
          reason,
          // willRetry=false: agotamos reintentos. Señal para bloquear nuevos viajes + alerta central.
          willRetry: false,
        },
      });
      await this.repo.enqueueOutbox(tx, envelope, updated.id);
      return updated;
    });
  }

  async getPayment(id: string): Promise<Payment> {
    const payment = await this.repo.findPaymentById(id);
    if (!payment) throw new NotFoundError('Pago no encontrado');
    return payment;
  }

  /**
   * Lookup canónico del cobro REEMBOLSABLE de un viaje (A1 · `kind=FARE`: la TARIFA, nunca la propina del
   * mismo viaje). Acepta un cobro CAPTURED o ya PARCIALMENTE reembolsado (para acumular parciales, BR-P06);
   * el más reciente. Devuelve `null` si no hay — cada caller decide el desenlace (refund lanza, la
   * cancelación de booking hace skip, el getter del admin lanza NotFound). Único punto que define "el pago
   * que se reembolsaría", para que la vista del admin == lo que efectivamente se reembolsa.
   */
  private findRefundablePaymentByTrip(tripId: string): Promise<Payment | null> {
    return this.repo.findRefundablePaymentByTrip(tripId);
  }

  /**
   * El cobro reembolsable de un viaje, para que el operador de finanzas lo INSPECCIONE antes de reembolsar
   * (misma cláusula que `refund` → "lo que veo es lo que se reembolsará"). Lanza NotFound si no hay. La
   * fila cruda se recorta a una view PII-consciente en el admin-bff (el shaping vive en el BFF, no acá).
   */
  async getPaymentByTrip(tripId: string): Promise<Payment> {
    const payment = await this.findRefundablePaymentByTrip(tripId);
    if (!payment) throw new NotFoundError('No hay un cobro reembolsable para este viaje');
    return payment;
  }

  /**
   * Ítems ACCIONABLES de un pasajero (BR-P02). Tres clases, en una sola respuesta:
   *  - kind=DEBT: cobros en status=DEBT (reintentos agotados). Alimentan el GATE de nuevos viajes del
   *    BFF y la franja "Resolver" del home.
   *  - kind=CANCELLATION_PENALTY: penalidades de cancelación en status=PENDING (F2). Son obligaciones
   *    cobrables que BLOQUEAN el gate igual que la deuda (cuentan en `hasDebt`/`totalCents`).
   *  - kind=PENDING_ACTION: cobros en status=PENDING con un checkout VIVO (ProntoPaga) esperando que el
   *    usuario complete el pago (externalUid presente + al menos uno de checkoutUrl/deepLink/qrCode/cip).
   *    NO es deuda y NO bloquea el gate: es el "pago por completar" que, si el usuario cerraba el sheet,
   *    quedaba en un dead-end (un Payment vivo sin camino de vuelta). Lo exponemos para "Continuar".
   *
   * Tres `findMany` por status exacto (cada uno cubierto por su índice [passengerId, status]); el filtro
   * de "checkout vivo" sobre los PENDING se hace en memoria (subconjunto pequeño por pasajero). El
   * passengerId SIEMPRE sale de la identidad firmada (InternalIdentityGuard), nunca de un parámetro del
   * cliente (anti-IDOR). `hasDebt`/`totalCents` resumen lo BLOQUEANTE (DEBT + CANCELLATION_PENALTY).
   */
  async getDebtForPassenger(passengerId: string): Promise<DebtSummary> {
    // A1 · `kind: 'FARE'`: el gate de deuda del pasajero es sobre obligaciones de VIAJE. Una propina (kind=TIP)
    // es OPCIONAL: si su cobro declina NO es deuda bloqueante ni un "pago por completar" del gate — no puede
    // impedirle pedir viajes. Su reintento vive en la UI de propina, no acá.
    const debtRows = await this.repo.findPassengerDebtPayments(passengerId);
    const debtItems: DebtItem[] = debtRows.map((r) => ({
      paymentId: r.id,
      tripId: r.tripId,
      amountCents: r.amountCents,
      reason: r.failureReason ?? 'unknown',
      createdAt: r.createdAt.toISOString(),
      kind: 'DEBT',
    }));

    // PENDING con checkout VIVO = pagos por completar (accionables). Un PENDING sin externalUid ni
    // medios de checkout es un cobro en curso (efectivo esperando confirmación bilateral, on-file
    // server-initiated sin checkout): NO accionable por el usuario → fuera.
    // A1 · `kind: 'FARE'` (en el repo): idem — un cobro de propina PENDING con checkout NO es un "pago del viaje
    // por completar" del gate. La propina se completa desde su propia UI, no desde la franja de deuda del viaje.
    const pendingRows = await this.repo.findPassengerPendingPayments(passengerId);
    const pendingActionItems: DebtItem[] = pendingRows
      .filter(
        (r) =>
          r.externalUid != null &&
          (r.checkoutUrl != null || r.deepLink != null || r.qrCode != null || r.cip != null),
      )
      .map((r) => ({
        paymentId: r.id,
        tripId: r.tripId,
        amountCents: r.amountCents,
        reason: '',
        createdAt: r.createdAt.toISOString(),
        kind: 'PENDING_ACTION',
      }));

    // Penalidades de cancelación PENDING (F2): obligaciones cobrables que BLOQUEAN el gate igual que la deuda.
    const penaltyRows = await this.repo.findPassengerPendingPenalties(passengerId);
    const penaltyItems: DebtItem[] = penaltyRows.map((r) => ({
      penaltyId: r.id,
      tripId: r.tripId,
      amountCents: r.penaltyCents,
      reason: r.reason ?? 'cancellation',
      createdAt: r.createdAt.toISOString(),
      kind: 'CANCELLATION_PENALTY',
    }));

    // hasDebt/totalCents = lo que BLOQUEA el gate: DEBT + penalidades de cancelación PENDING. Los
    // PENDING_ACTION (pago por completar) van en la lista pero NO bloquean.
    const blocking = [...debtItems, ...penaltyItems];
    const totalCents = blocking.reduce((acc, d) => acc + d.amountCents, 0);
    return {
      hasDebt: blocking.length > 0,
      debts: [...blocking, ...pendingActionItems],
      totalCents,
    };
  }

  /**
   * Re-cobra un Payment en DEBT (saldar deuda). Idempotente y concurrencia-segura:
   *  - Sobre un pago YA CAPTURED → no-op (devuelve el estado actual; la deuda ya se saldó).
   *  - Sobre DEBT → status-guard TRANSACCIONAL (`updateMany where status=DEBT` → DEBT→PENDING).
   *    Solo UN llamador gana el guard (count=1); los concurrentes ven count=0 y no re-cobran.
   *  - gateway 'aggregator' (ProntoPaga): re-corre el cobro → nuevo checkout (urlPay/deepLink/qr/cip),
   *    el Payment queda PENDING y el poll/webhook existente lo cierra (CAPTURED o vuelve a DEBT).
   *  - gateway 'direct' (live/sandbox): re-corre el riel con reintentos → CAPTURED o DEBT.
   * NO valida ownership: el BFF lo hace ANTES (passengerId === user, 404 anti-enumeración).
   */
  async retryCharge(id: string): Promise<Payment> {
    const payment = await this.repo.findPaymentById(id);
    if (!payment) throw new NotFoundError('Pago no encontrado');

    // Idempotencia: si ya se capturó (p.ej. un webhook entró entre medio), no re-cobramos.
    if (payment.status === 'CAPTURED' || payment.status === 'REFUNDED') {
      return payment;
    }
    // PENDING = ya hay un re-cobro/cobro EN CURSO (lo movió el ganador de un retry concurrente, o es el
    // cobro original aún abierto). No-op idempotente: devolvemos el estado vigente sin disparar otro cobro.
    if (payment.status === 'PENDING') {
      return payment;
    }
    // FAILED = cobro externo cancelado/expirado (estado terminal, no es una deuda viva): no se re-cobra.
    if (payment.status !== 'DEBT') {
      throw new InvalidStateError(
        `Solo un cobro en DEBT puede re-cobrarse (estado actual: ${payment.status})`,
      );
    }
    // CASH no pasa por el riel (confirmación bilateral, BR-P03): no aplica re-cobro al gateway.
    if (payment.method === 'CASH') {
      throw new InvalidStateError(
        'Un cobro en efectivo se salda por confirmación bilateral, no por re-cobro',
      );
    }

    // Status-guard transaccional: DEBT→PENDING SOLO si sigue en DEBT (gana un único llamador concurrente).
    const claimed = await this.repo.claimDebtForRetry(id);
    if (claimed.count === 0) {
      // Otro intento concurrente ya lo movió: devolvemos el estado vigente (no-op idempotente).
      return this.getPayment(id);
    }

    const reclaimed = await this.repo.findPaymentById(id);
    if (!reclaimed) throw new NotFoundError('Pago no encontrado');

    // Re-cobro por el mismo camino que el cobro original, según el flujo que DECLARA el adapter:
    // aggregator → nuevo checkout asíncrono (el poll/webhook existente cierra el Payment);
    // direct → reintentos contra el riel → CAPTURED o de vuelta a DEBT.
    return this.dispatchDigitalCharge(reclaimed, {
      tripId: reclaimed.tripId,
      grossCents: reclaimed.grossCents,
      method: reclaimed.method,
      dedupKey: reclaimed.dedupKey,
      userId: reclaimed.passengerId ?? undefined,
      payerRef: reclaimed.payerRef ?? undefined,
    });
  }

  /**
   * Cambia el MÉTODO de un Payment no-capturado (PENDING o DEBT) a otro método DIGITAL y re-corre el
   * cobro con el método nuevo. DECISIÓN DEL DUEÑO: un pago de un viaje YA HECHO que el usuario no pudo
   * pagar (no le anduvo el Yape) debe poder cambiar de medio (elige otro DIGITAL) sin rehacer el viaje.
   *
   * DISTINCIÓN HISTÓRICA CLAVE (NO confundir):
   *  - `Trip.paymentMethod` = lo que el pasajero ELIGIÓ al PEDIR el viaje. Es HISTÓRICO/inmutable: NO se
   *    toca acá (vive en otro servicio, regla #2). Refleja la intención original del viaje.
   *  - `Payment.method`     = cómo se está LIQUIDANDO el cobro AHORA. Antes era inmutable; lo hacemos
   *    mutable SOLO para pagos no-capturados y SOLO entre métodos DIGITALES. Cambiarlo NO reescribe la
   *    historia del viaje: solo cambia el riel por el que se intenta cobrar el saldo pendiente.
   *
   * Guards (en orden):
   *  1. Estado: solo PENDING o DEBT. CAPTURED/REFUNDED/FAILED → InvalidStateError 409 (ya no se cambia).
   *  2. Método: CASH NO permitido (post-viaje el conductor no está para la confirmación bilateral,
   *     BR-P03) → UnprocessableEntityError 422.
   *  3. No-op idempotente: si el método pedido == el actual, NO re-cobramos: devolvemos el estado vigente
   *     (si es un PENDING con checkout vivo, lo mismo — no rompemos un checkout en curso del mismo medio).
   *
   * Cambio real (transaccional + concurrencia-seguro, igual que retryCharge):
   *  - status-guard `updateMany where status in (PENDING,DEBT)`: setea method nuevo, LIMPIA los checkout
   *    fields viejos (externalUid/checkoutUrl/qrCode/deepLink/cip/checkoutExpiresAt) y normaliza a PENDING
   *    (DEBT→PENDING). Solo UN llamador concurrente gana el guard (count=1); el resto ve count=0 → no-op.
   *  - re-corre el cobro con el método nuevo por el MISMO camino que el cobro original según el flujo
   *    que DECLARA el adapter: 'aggregator' → nuevo checkout PENDING; 'direct' → riel con reintentos.
   * NO valida ownership: el BFF lo hace ANTES (passengerId === user, 404 anti-enumeración).
   */
  async changeMethod(id: string, method: PaymentMethod): Promise<Payment> {
    const payment = await this.repo.findPaymentById(id);
    if (!payment) throw new NotFoundError('Pago no encontrado');

    // Guard ESTADO: solo un pago NO-capturado se puede cambiar. CAPTURED/REFUNDED/FAILED son terminales
    // (o ya liquidados) → 409: la app muestra "Este pago ya no se puede cambiar".
    if (payment.status !== 'PENDING' && payment.status !== 'DEBT') {
      throw new InvalidStateError('Este pago ya no se puede cambiar');
    }

    // Guard MÉTODO: CASH fuera. El efectivo se captura por confirmación bilateral con el conductor
    // presente (BR-P03); post-viaje ya no está → no es un medio válido para saldar un pendiente.
    if (method === 'CASH') {
      throw new UnprocessableEntityError('El efectivo no está disponible para pagos pendientes');
    }

    // Guard CAPACIDAD (mismo que charge y settleCancellationPenalty): el método nuevo solo si el
    // adapter activo lo DECLARA en su catálogo — sin esto se re-cobraba por un riel que no habla el
    // método (p.ej. CARD contra el riel directo Yape/Plin) y el error aparecía recién en el gateway.
    this.assertGatewaySupportsMethod(method);

    // No-op idempotente: mismo método pedido. NO re-cobramos ni rompemos un checkout vivo del mismo medio;
    // devolvemos el estado vigente (un PENDING con checkout válido sigue tal cual; un DEBT se mantiene).
    if (method === payment.method) {
      return payment;
    }

    // Status-guard transaccional: aplica el cambio SOLO si sigue en PENDING o DEBT (gana un único
    // llamador concurrente). Setea el método nuevo, LIMPIA el checkout viejo (era del método anterior:
    // un deepLink Yape no sirve para PLIN) y normaliza a PENDING (DEBT→PENDING) para re-cobrar limpio.
    const claimed = await this.repo.claimForMethodChange(id, method);
    if (claimed.count === 0) {
      // Otro intento concurrente ya lo movió (o se capturó entre medio): estado vigente (no-op idempotente).
      return this.getPayment(id);
    }

    const reclaimed = await this.repo.findPaymentById(id);
    if (!reclaimed) throw new NotFoundError('Pago no encontrado');

    // Re-cobro con el método NUEVO por el mismo camino que el cobro original, según el flujo que
    // DECLARA el adapter: aggregator → nuevo checkout del método nuevo (el poll/webhook existente lo
    // cierra); direct → reintentos contra el riel → CAPTURED o de vuelta a DEBT.
    return this.dispatchDigitalCharge(reclaimed, {
      tripId: reclaimed.tripId,
      grossCents: reclaimed.grossCents,
      method: reclaimed.method,
      dedupKey: reclaimed.dedupKey,
      userId: reclaimed.passengerId ?? undefined,
      payerRef: reclaimed.payerRef ?? undefined,
    });
  }

  /**
   * Aplica el resultado de un webhook de cobro (ProntoPaga). IDEMPOTENTE:
   *  - Busca el Payment por `order` (= paymentId).
   *  - CONFIRMED: si ya CAPTURED → no-op (200). Si PENDING/DEBT/FAILED → captura (emite payment.captured).
   *  - DECLINED:  PENDING → DEBT (bloqueo + alerta, semántica actual). Si ya capturado → no-op.
   *  - EXPIRED:   PENDING → FAILED reason 'expired'.
   *  - PENDING:   no-op (el cobro sigue en curso).
   * Una redelivery del mismo webhook no duplica la captura (status-guard + transición idempotente).
   */
  async applyWebhookResult(input: {
    paymentId?: string;
    externalUid: string;
    status: WebhookStatus;
    /** Código de error del proveedor (p.ej. YPTRX002 = saldo insuficiente) para un recibo honesto. */
    errorCode?: string;
  }): Promise<{ applied: boolean; status: string }> {
    let paymentId = input.paymentId;
    if (!paymentId) {
      // Sin `order` no podemos correlacionar; intentamos por externalUid (defensivo).
      const byUid = await this.repo.findPaymentByExternalUid(input.externalUid);
      if (!byUid) {
        this.logger.warn(`Webhook de pago sin match (uid=${input.externalUid}); no-op`);
        return { applied: false, status: 'NO_MATCH' };
      }
      paymentId = byUid.id;
    }

    const payment = await this.repo.findPaymentById(paymentId);
    if (!payment) {
      this.logger.warn(`Webhook de pago sin match (paymentId=${paymentId}); no-op`);
      return { applied: false, status: 'NO_MATCH' };
    }

    // Guard idempotente COMÚN a las 3 ramas: un webhook (CONFIRMED/DECLINED/EXPIRED) que llega sobre un pago YA
    // LIQUIDADO (CAPTURED/REFUNDED/PARTIALLY_REFUNDED) es TARDÍO/stale — la plata ya se capturó (y quizá se
    // reembolsó). NO-OP idempotente, NO un error. Antes PARTIALLY_REFUNDED (en las 3) y REFUNDED (en CONFIRMED)
    // caían a captureSuccess/markDebt y assertPaymentTransition lanzaba InvalidStateError → el proveedor re-
    // entregaba en loop (no-2xx). PARTIALLY_REFUNDED→X y REFUNDED→X no son transiciones válidas (payment.policy).
    if (isSettledPayment(payment.status)) {
      return { applied: false, status: payment.status };
    }

    switch (input.status) {
      case 'CONFIRMED': {
        await this.captureSuccess(payment, input.externalUid, payment.retries || 1);
        return { applied: true, status: 'CAPTURED' };
      }
      case 'DECLINED': {
        if (payment.status === 'DEBT') return { applied: false, status: 'DEBT' };
        // YPTRX002 = saldo insuficiente (cobro Yape On File): razón honesta para el recibo del pasajero.
        const reason =
          input.errorCode === YAPE_INSUFFICIENT_FUNDS_CODE
            ? YAPE_INSUFFICIENT_FUNDS_REASON
            : 'declined_by_provider';
        await this.markDebt(payment, reason);
        return { applied: true, status: 'DEBT' };
      }
      case 'EXPIRED': {
        if (payment.status === 'FAILED') return { applied: false, status: 'FAILED' };
        if (payment.status === 'DEBT') return { applied: false, status: 'DEBT' }; // idempotente (espejo DECLINED)
        // Un checkout que EXPIRA para el cobro de un viaje COMPLETADO NO es "no pasó nada": la tarifa se DEBE
        // igual (el viaje ocurrió). Va a DEBT (gatea al pasajero + reintentable), IGUAL que DECLINED — NO a
        // FAILED terminal, que dejaba el viaje GRATIS (sin cobro, sin gate, sin reintento → fuga de ingresos).
        // markDebt rutea por kind: una PROPINA (kind=TIP) que expira SÍ es FAILED terminal (opcional, no se debe).
        await this.markDebt(payment, 'checkout_expired');
        return { applied: true, status: payment.kind === 'TIP' ? 'FAILED' : 'DEBT' };
      }
      default:
        return { applied: false, status: payment.status }; // PENDING → sin transición
    }
  }

  /**
   * Añade una propina a un viaje YA cobrado (BR-P04 · A1 ADR-022 · Model B): el 100% va al conductor, fuera de
   * comisión. TODA propina iniciada en el app se COBRA DIGITAL (no existe "propina en mano" iniciada por el app):
   * crea un cobro dedicado (tip-Payment `kind=TIP`, gross 0, comisión 0) que pasa por el gateway. El conductor la
   * cobra SOLO cuando el cobro CAPTURA (captureSuccess emite `payment.tip_added` + entra al payout por su
   * `tipCents`). Antes NO se cobraba nada al pasajero y el conductor la recibía igual → la plataforma la subsidiaba.
   * Idempotente por `Payment.dedupKey` (namespaced `tip-charge:`): reenviar la misma propina no la duplica.
   */
  async addTip(input: { tripId: string; tipCents: number; dedupKey: string }): Promise<Payment> {
    if (!Number.isInteger(input.tipCents) || input.tipCents <= 0) {
      throw new InvalidStateError('tipCents debe ser un entero de céntimos positivo');
    }

    // Idempotencia: si ya iniciamos el cobro de esta propina (tip-Payment), lo devolvemos sin re-cobrar.
    const existingTipCharge = await this.repo.findPaymentByDedupKey(
      deriveTipChargeDedupKey(input.dedupKey),
    );
    if (existingTipCharge) return existingTipCharge;

    // El cobro de la TARIFA del viaje (kind=FARE): de él tomamos conductor/pasajero/payerRef y el método (si fue
    // digital). El filtro `kind=FARE` evita agarrar un tip-Payment previo del mismo viaje (matchearía por tripId).
    const fare = await this.repo.findLiveFareByTrip(input.tripId);
    if (!fare)
      throw new NotFoundError('No hay un cobro vivo para este viaje al que añadir propina');
    assertCanAddTip(fare.status);

    return this.chargeTipDigital(fare, input.tipCents, input.dedupKey);
  }

  /**
   * A1 (Model B) · Propina DIGITAL: cobro dedicado (tip-Payment `kind=TIP`, gross 0, comisión 0, 100% al conductor)
   * que pasa por el MISMO despacho digital que la tarifa. El MÉTODO de la propina = el de la tarifa si fue digital;
   * si el viaje se pagó en EFECTIVO cae a YAPE por defecto (on-file resolviendo el walletUid server-side por `userId`,
   * o un checkout QR). Queda PENDING hasta que el webhook lo CAPTURA; recién ahí `captureSuccess` emite
   * `payment.tip_added` y el `tipCents` entra al payout (collectEarnings). Idempotente por `Payment.dedupKey`.
   */
  private async chargeTipDigital(
    fare: Payment,
    tipCents: number,
    clientDedupKey: string,
  ): Promise<Payment> {
    const dedupKey = deriveTipChargeDedupKey(clientDedupKey);
    // Model B: la propina SIEMPRE se cobra digital. Si el viaje fue en EFECTIVO no puede heredar CASH (el gateway
    // no cobra efectivo) → cae al método digital por defecto (YAPE); si fue digital, cobra con el MISMO método.
    const method = (
      isCashMethod(fare.method) ? DEFAULT_DIGITAL_TIP_METHOD : fare.method
    ) as Extract<PaymentMethod, 'YAPE' | 'PLIN' | 'CARD' | 'PAGOEFECTIVO'>;
    let tip: Payment;
    try {
      tip = await this.repo.createPayment({
        id: uuidv7(),
        tripId: fare.tripId,
        driverId: fare.driverId,
        passengerId: fare.passengerId,
        dedupKey,
        kind: 'TIP',
        amountCents: tipCents,
        grossCents: 0,
        discountCents: 0,
        creditCents: 0,
        tipCents,
        commissionCents: 0,
        feeCents: 0,
        method,
        mode: 'ON_DEMAND',
        payerRef: fare.payerRef,
        status: 'PENDING',
      });
    } catch (err) {
      if (isUniqueViolation(err, 'dedupKey')) {
        const dup = await this.repo.findPaymentByDedupKey(dedupKey);
        if (dup) return dup;
        throw new ConflictError('Cobro de propina duplicado para la misma dedupKey');
      }
      throw err;
    }
    // Mismo despacho digital que la tarifa. NO reusamos charge() a propósito: una propina NO canjea promo ni
    // gasta crédito del pasajero (esos reducen la tarifa, no la propina del conductor).
    return this.dispatchDigitalCharge(tip, {
      tripId: fare.tripId,
      grossCents: 0,
      tipCents,
      method,
      dedupKey,
      driverId: fare.driverId ?? undefined,
      userId: fare.passengerId ?? undefined,
      payerRef: fare.payerRef ?? undefined,
      mode: ChargeMode.ON_DEMAND,
    });
  }

  /**
   * Agrega los cobros CAPTURED de un conductor en una ventana [from, to) (BR-P05). Devuelve el
   * desglose real (sin mocks) para la pantalla de ganancias: bruto, comisión, propinas, neto y nº
   * de viajes. neto = (bruto − comisión) + propinas.
   */
  async earningsForDriver(
    driverId: string,
    from: Date,
    to: Date,
  ): Promise<DriverEarningsBreakdown> {
    // Espeja EXACTO el filtro de collectEarnings (payouts.service:781): incluye PARTIALLY_REFUNDED — un
    // reembolso PARCIAL al pasajero lo absorbe la plataforma, el conductor cobra la tarifa ENTERA (gross/
    // comisión completos, sin restar refundedCents). Antes la pantalla filtraba solo CAPTURED → sub-reportaba
    // lo que el conductor efectivamente cobra por banco (divergía del payout real).
    const rows = await this.repo.findDriverCapturedPayments(driverId, from, to);
    let grossCents = 0;
    let commissionCents = 0;
    let tipCents = 0;
    let cashNetCents = 0;
    let tripCount = 0;
    for (const r of rows) {
      // Bruto/comisión/propina se suman de TODOS los cobros (un tip-Payment aporta 0 bruto/comisión + su
      // propina); pero el CONTEO de viajes es solo de las TARIFAS (kind=FARE): una propina NO es un viaje.
      grossCents += r.grossCents;
      commissionCents += r.commissionCents;
      tipCents += r.tipCents;
      // Split por método: el neto de un cobro CASH ya está EN MANO del conductor (cobró el bruto; su
      // comisión queda como DriverDebt a netear en la liquidación). El resto (digital) le cae por payout.
      if (r.method === 'CASH') cashNetCents += r.grossCents - r.commissionCents + r.tipCents;
      if (r.kind === 'FARE') tripCount += 1;
    }
    const netCents = grossCents - commissionCents + tipCents;
    return {
      grossCents,
      commissionCents,
      tipCents,
      netCents,
      cashNetCents,
      // Complemento exacto: cash + digital = neto total (invariante del split, sin re-sumar filas).
      digitalNetCents: netCents - cashNetCents,
      tripCount,
    };
  }

  /**
   * Confirmación bilateral de efectivo (BR-P03). Cuando ambas partes confirman → captura.
   * Si una parte disputa (confirmed=false) → evento de discrepancia para ticket de soporte.
   */
  async confirmCash(
    paymentId: string,
    callerUserId: string,
    party: 'driver' | 'passenger',
    confirmed: boolean,
  ): Promise<{
    tripId: string;
    driverConfirmed: boolean;
    passengerConfirmed: boolean;
    status: string;
  }> {
    const payment = await this.repo.findPaymentById(paymentId);
    if (!payment) throw new NotFoundError('Pago no encontrado');
    if (payment.method !== 'CASH') throw new InvalidStateError('El pago no es en efectivo');

    // Defensa en profundidad (anti-IDOR): el caller (identidad firmada) DEBE ser el party que dice ser;
    // no alcanza con que el BFF lo gatee. 404 anti-enumeración (mismo criterio que el resto de payments).
    const isDriver = party === 'driver';
    const expectedUserId = isDriver ? payment.driverId : payment.passengerId;
    if (!expectedUserId || expectedUserId !== callerUserId) {
      throw new NotFoundError('Pago no encontrado');
    }
    const tripId = payment.tripId;

    const data = isDriver ? { driverConfirmed: confirmed } : { passengerConfirmed: confirmed };
    const confirmation = await this.repo.upsertCashConfirmation(tripId, data);

    // Disputa explícita → discrepancia (BR-P03): dispara ticket de soporte vía evento.
    if (!confirmed) {
      await this.emitCashDiscrepancy(payment.id, tripId);
      return {
        tripId,
        driverConfirmed: confirmation.driverConfirmed,
        passengerConfirmed: confirmation.passengerConfirmed,
        status: 'DISPUTED',
      };
    }

    if (
      confirmation.driverConfirmed &&
      confirmation.passengerConfirmed &&
      payment.status === 'PENDING'
    ) {
      await this.captureCash(payment);
      return { tripId, driverConfirmed: true, passengerConfirmed: true, status: 'CAPTURED' };
    }

    return {
      tripId,
      driverConfirmed: confirmation.driverConfirmed,
      passengerConfirmed: confirmation.passengerConfirmed,
      status: payment.status,
    };
  }

  private async captureCash(payment: Payment): Promise<void> {
    assertPaymentTransition(payment.status, 'CAPTURED');
    await this.repo.runInTransaction(async (tx) => {
      // CAS atómico: el estado va en el WHERE (invariante en el repo). Dos confirmaciones bilaterales concurrentes
      // (driver+passenger en la misma ventana de ms) leen ambas PENDING; solo la que matchea PENDING→CAPTURED gana
      // → un único payment.captured (sin push duplicado). El check en confirmCash es TOCTOU contra el read stale;
      // este CAS cierra la ventana.
      const { count } = await this.repo.casCaptureCash(tx, payment.id, {
        status: 'CAPTURED',
        capturedAt: new Date(),
        externalRef: `cash:${payment.tripId}`,
        // P-B · el efectivo NO pasa por el PSP → fee 0, el neto = el bruto (la plata la recauda el conductor en mano).
        pspFeeCents: 0,
        netSettledCents: payment.amountCents,
      });
      if (count === 0) return; // otra captura concurrente ya ganó: no re-emitir
      // A2 · el conductor cobró la comisión de este viaje EN EFECTIVO → la DEBE a la plataforma (la plata la
      // recaudó él en mano). Se acumula en el ledger DriverDebt DENTRO de la MISMA tx de captura (atomicidad:
      // captura ⇔ deuda), para netearla luego contra su payout digital. El CAS count>0 garantiza una sola captura
      // → una sola deuda (idempotente; el UNIQUE(paymentId) es el backstop). Solo si hay comisión (carpooling
      // 100% → comisión 0 → no acumula) y conductor.
      if (payment.driverId && payment.commissionCents > 0) {
        await this.repo.createDriverDebtInTx(tx, {
          id: uuidv7(),
          driverId: payment.driverId,
          tripId: payment.tripId,
          paymentId: payment.id,
          amountCents: payment.commissionCents,
          currency: payment.currency,
          reason: 'CASH_COMMISSION',
          status: 'PENDING',
        });
      }
      const envelope = createEnvelope({
        eventType: 'payment.captured',
        producer: 'payment-service',
        payload: {
          // Campos inmutables post-create → tomar del payment leído es correcto (updateMany no retorna fila).
          paymentId: payment.id,
          tripId: payment.tripId,
          method: payment.method,
          grossCents: payment.grossCents,
          commissionCents: payment.commissionCents,
          // ENRIQUECIDO: push "pago confirmado · S/X.XX" al pasajero (notification-service).
          passengerId: payment.passengerId ?? undefined,
        },
      });
      await this.repo.enqueueOutbox(tx, envelope, payment.id);
    });
  }

  private async emitCashDiscrepancy(paymentId: string, tripId: string): Promise<void> {
    await this.repo.runInTransaction(async (tx) => {
      const envelope = createEnvelope({
        eventType: 'payment.failed',
        producer: 'payment-service',
        payload: { paymentId, tripId, reason: 'CASH_DISCREPANCY', willRetry: false },
      });
      await this.repo.enqueueOutbox(tx, envelope, paymentId);
    });
  }

  /**
   * Reembolso (BR-P06): ventana de 7 días desde la captura; aprobación L1/L2 según monto
   * (>S/30 requiere L2). Branch TIPADO por método (S5):
   *
   *  - CASH → la plata se devuelve FUERA del riel (decisión del dominio: el efectivo nunca pasó por el
   *    gateway). El flujo local queda: Refund COMPLETED + payment.refunded en una sola transacción.
   *  - DIGITAL (YAPE/PLIN/CARD/PAGOEFECTIVO) → reembolso REAL contra el proveedor:
   *      1) RESERVA transaccional del saldo en el Payment (CAS optimista) + Refund PENDING — el intent
   *         queda PERSISTIDO ANTES de llamar al riel (INTEGRACIONES §4) con key `refund-{refundId}`.
   *      2) gateway.refund: ACCEPTED síncrono → COMPLETED + payment.refunded; PENDING (ProntoPaga,
   *         asíncrono) → se guarda el uid del reverso y lo CIERRA el callback (applyRefundWebhookResult)
   *         — la notificación "te devolvimos S/X" sale recién cuando la plata efectivamente volvió;
   *         REJECTED → se COMPENSA la reserva y se devuelve un error tipado (nunca éxito falso).
   *      3) TIMEOUT ≠ FALLA: ante un fallo transitorio NO se compensa ni se marca rechazado — el Refund
   *         queda PENDING y lo resuelve el callback/conciliación (no se re-llama a ciegas: ProntoPaga
   *         no soporta idempotencia en /reverse/new).
   *
   * `status` devuelto = estado del REFUND: 'COMPLETED' (la plata volvió) o 'PENDING' (reverso aceptado
   * o en confirmación). Degradación honesta: nunca se reporta COMPLETED sin confirmación del proveedor.
   */
  /**
   * COLA DE APROBACIÓN — paso 1 (SOLICITAR · money-OUT · frame HZ8uz). El operador CREA una solicitud de reembolso
   * en estado PENDING que AÚN NO desembolsa: la plata NO se mueve hasta que un operador la APRUEBE (`approveRefund`).
   * Esto reemplaza el direct-issue (que desembolsaba en el acto) por un flujo con approval-gate + dual-control.
   *
   * Valida saldo/ventana/monto>0 (el gate de AUTORIDAD por monto alto se aplica al APROBAR, no acá: un FINANCE puede
   * FILAR la solicitud; un ADMIN/SUPERADMIN la aprueba si supera el umbral). NO reserva el Payment ni llama al riel.
   *
   * IDEMPOTENCIA de la CREACIÓN (no crear DOS solicitudes del mismo dinero por un doble-submit): igual barrera que el
   * viejo direct-issue — `Idempotency-Key` → `dedupKey` (UNIQUE PARCIAL) + backstop de VENTANA sobre (paymentId,
   * céntimos) bajo advisory lock. Un reintento devuelve la solicitud existente, no crea otra.
   */
  async requestRefund(
    tripId: string,
    amountCents: number,
    reason: string,
    operator: AuthenticatedUser,
    idempotencyKey?: string,
    // Gesto EXPLÍCITO del operador "es un reembolso NUEVO, no un reintento": salta el backstop de ventana para
    // permitir una 2da solicitud parcial idéntica legítima (el server no la distingue de un reintento sin esta señal).
    forceNew = false,
    // RC18 · el operador marca que el refund es por causa ATRIBUIBLE al conductor (viaje no realizado / fraude
    // del conductor) → un refund TOTAL clawbackea su neto ya pagado. Default false = lo absorbe la plataforma.
    driverFault = false,
    // `deduped=true` ⇒ NO se creó una solicitud nueva: se devolvió una RECIENTE existente (backstop de ventana o
    // idempotencia por key). El panel lo usa para NO mentir "enviada" y ofrecer "forzar uno nuevo" (forceNew).
  ): Promise<{ refundId: string; paymentId: string; status: string; deduped: boolean }> {
    // Acepta un cobro CAPTURED o ya PARCIALMENTE reembolsado (para acumular más parciales, BR-P06).
    const payment = await this.findRefundablePaymentByTrip(tripId);
    if (!payment) throw new NotFoundError('No hay un cobro reembolsable para este viaje');
    if (amountCents <= 0) throw new InvalidStateError('El reembolso debe ser un monto positivo');
    // Valida contra el SALDO reembolsable (amount − ya reembolsado), no contra el bruto original.
    const remainingCents = payment.amountCents - payment.refundedCents;
    if (amountCents > remainingCents) {
      throw new InvalidStateError(
        `El reembolso (${amountCents}) excede el saldo reembolsable (${remainingCents})`,
      );
    }

    const capturedAt = payment.capturedAt ?? payment.createdAt;
    const ageDays = (Date.now() - capturedAt.getTime()) / 86_400_000;
    if (ageDays > this.refundWindowDays) {
      throw new InvalidStateError(
        `Fuera de la ventana de reembolso (${this.refundWindowDays} días)`,
      );
    }

    const dedupKey = idempotencyKey ? deriveAdminRefundDedupKey(idempotencyKey) : null;
    try {
      return await this.repo.runInTransaction(async (tx) => {
        // Backstop de VENTANA (salvo forceNew): bajo advisory lock por paymentId, si ya hay una solicitud/reembolso
        // reciente NO-RECHAZADO del MISMO (paymentId, céntimos) → devolver esa (no crear otra). Cierra el residual
        // del nonce de cliente (storage bloqueado, cross-tab, cross-device) que el `dedupKey` solo no cubre.
        if (!forceNew) {
          await this.repo.acquirePaymentAdvisoryLock(tx, payment.id);
          const since = new Date(Date.now() - this.refundIdempotencyWindowMs);
          const recent = await this.repo.findRecentRefundInWindowInTx(
            tx,
            payment.id,
            amountCents,
            since,
          );
          if (recent) {
            throw new DuplicateRefundInWindowError({
              refundId: recent.id,
              paymentId: recent.paymentId,
              status: recent.status,
            });
          }
        }
        const refund = await this.repo.createRefundInTx(tx, {
          id: uuidv7(),
          paymentId: payment.id,
          amountCents,
          requestedBy: operator.userId,
          // approvedBy queda NULL hasta que un operador la apruebe (la cola de "Solicitados").
          dedupKey,
          status: RefundStatus.PENDING,
          reason,
          // RC18 · se persiste al SOLICITAR; `completeRefund` lo lee al confirmar el reverso digital para decidir el
          // clawback del neto del conductor (la solicitud PENDING → APPROVED/COMPLETED no lo re-escribe).
          clawbackDriver: driverFault,
        });
        return { refundId: refund.id, paymentId: payment.id, status: refund.status, deduped: false };
      });
    } catch (err) {
      // BACKSTOP DE VENTANA: misma operación (reintento con otro key / sin key) → devolver la solicitud existente.
      if (err instanceof DuplicateRefundInWindowError) {
        this.logger.log(
          `Solicitud de reembolso idempotente por VENTANA (mismo pago y monto) trip=${tripId}; ` +
            `devuelvo la existente ${err.existing.refundId}`,
        );
        return { ...err.existing, deduped: true };
      }
      // IDEMPOTENCIA por key: el MISMO `Idempotency-Key` ya creó una solicitud ACTIVA (UNIQUE parcial) → P2002.
      // Leemos del PRIMARIO (read-after-write). Solo devolvemos la existente si coincide en (pago, monto); un key
      // reusado para OTRO dinero → conflicto explícito (nunca un refund ajeno como éxito falso).
      if (idempotencyKey && dedupKey && isUniqueViolation(err, 'dedupKey')) {
        const existing = await this.repo.findRefundByDedupKeyOnPrimary(dedupKey);
        if (existing && existing.paymentId === payment.id && existing.amountCents === amountCents) {
          this.logger.log(
            `Solicitud de reembolso idempotente (mismo key, pago y monto) trip=${tripId}; devuelvo la existente`,
          );
          return {
            refundId: existing.id,
            paymentId: existing.paymentId,
            status: existing.status,
            deduped: true,
          };
        }
        throw new ConflictError(
          'El Idempotency-Key ya se usó para otro reembolso (distinto pago o monto)',
          { tripId, paymentId: payment.id, amountCents },
        );
      }
      throw err;
    }
  }

  /**
   * COLA DE APROBACIÓN — paso 2 (APROBAR + DESEMBOLSAR · money-OUT). Transiciona la solicitud PENDING → APPROVED y
   * dispara el desembolso IDEMPOTENTE (reserva CAS + reverso al riel con key derivada del refundId → COMPLETED, o
   * queda APPROVED esperando el callback async; CASH devuelve local → COMPLETED). Re-VALIDA saldo/ventana/monto-alto
   * AL MOMENTO de aprobar (el estado pudo cambiar desde la solicitud). Idempotente: aprobar algo que ya salió de
   * PENDING devuelve su estado vigente sin re-desembolsar.
   */
  async approveRefund(
    refundId: string,
    operator: AuthenticatedUser,
  ): Promise<{ refundId: string; paymentId: string; status: string }> {
    const refund = await this.repo.findRefundById(refundId);
    if (!refund) throw new NotFoundError('Reembolso no encontrado');
    // Idempotencia: solo una solicitud PENDING se aprueba. Ya APPROVED/COMPLETED/REJECTED → devolver estado vigente
    // (un doble-submit del operador no re-desembolsa ni error-ea).
    if (refund.status !== RefundStatus.PENDING) {
      return { refundId, paymentId: refund.paymentId, status: refund.status };
    }
    // SEGREGACIÓN DE FUNCIONES (four-eyes · Ley 29733 money-OUT): el operador que APRUEBA (mueve la plata) NO puede
    // ser el MISMO que SOLICITÓ. Cierra el hueco documentado de auto-aprobación (antes solo lo mitigaba step-up MFA +
    // gate por monto + audit, sin dual-PERSON estricto). Se evalúa AL APROBAR (la acción que desembolsa) y ANTES de
    // tocar el cobro/riel. Los refunds SYSTEM-INITIATED (refundForBookingCancellation / propina revertida) NO pasan
    // por acá: nacen APPROVED vía executeRefundClaim (nunca quedan PENDING) y su `requestedBy` es SYSTEM_OPERATOR
    // ('system'), que jamás iguala el userId de un operador humano — doble razón por la que esta regla no los alcanza.
    if (refund.requestedBy === operator.userId) {
      throw new ForbiddenError(
        'Segregación de funciones: el solicitante no puede aprobar su propio reembolso; ' +
          'debe aprobarlo un operador distinto',
        { refundId, requestedBy: refund.requestedBy },
      );
    }
    const payment = await this.repo.findPaymentById(refund.paymentId);
    if (!payment) throw new NotFoundError('Pago no encontrado');

    // Re-validación al aprobar (defensa: el saldo/estado del cobro pudo moverse desde que se filó la solicitud).
    const remainingCents = payment.amountCents - payment.refundedCents;
    if (refund.amountCents > remainingCents) {
      throw new InvalidStateError(
        `El reembolso (${refund.amountCents}) excede el saldo reembolsable actual (${remainingCents})`,
      );
    }
    const capturedAt = payment.capturedAt ?? payment.createdAt;
    const ageDays = (Date.now() - capturedAt.getTime()) / 86_400_000;
    if (ageDays > this.refundWindowDays) {
      throw new InvalidStateError(
        `Fuera de la ventana de reembolso (${this.refundWindowDays} días)`,
      );
    }
    // Gate de monto alto (DUAL-CONTROL, decisión del dueño): aprobar un reembolso sobre el umbral exige autoridad
    // ELEVADA (ADMIN/SUPERADMIN); un FINANCE queda topado al umbral. Se aplica al APROBAR (es la acción que mueve
    // plata), no al solicitar. Compensa con step-up MFA + audit + tope por saldo.
    const needsElevatedAuthority = refund.amountCents > this.refundHighValueThresholdCents;
    const roles = operator.roles ?? [];
    const hasElevatedAuthority =
      roles.includes(AdminRole.ADMIN) || roles.includes(AdminRole.SUPERADMIN);
    if (needsElevatedAuthority && !hasElevatedAuthority) {
      throw new ForbiddenError(
        'Aprobar un reembolso de monto alto requiere un operador ADMIN o SUPERADMIN',
      );
    }

    const newRefundedCents = payment.refundedCents + refund.amountCents;
    const isFullyRefunded = newRefundedCents === payment.amountCents;
    const newStatus = isFullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    assertPaymentTransition(payment.status, newStatus);

    const claim: RefundClaim = {
      amountCents: refund.amountCents,
      reason: refund.reason,
      requestedBy: refund.requestedBy,
      // El APROBADOR firma la aprobación (dual-control: puede diferir de quien solicitó). Viaja en payment.refunded.
      approvedBy: operator.userId,
      dedupKey: refund.dedupKey,
      newStatus,
      newRefundedCents,
      isFullyRefunded,
      // RC18 · la causa (atribuible al conductor o no) se cristalizó al SOLICITAR y viaja en la fila; la propagamos
      // al claim por consistencia (la materialización por `existingRefundId` no re-escribe la columna).
      clawbackDriver: refund.clawbackDriver,
      // La solicitud ya dedupeó al crearse; aprobar es una acción distinta → sin backstop de ventana.
      enforceWindowDedup: false,
      // MATERIALIZA la solicitud PENDING existente (no crea una fila nueva): PENDING → APPROVED/COMPLETED por CAS.
      existingRefundId: refund.id,
    };

    try {
      const result = await this.executeRefundClaim(payment, claim);
      // A1 · refund TOTAL del viaje → también se devuelven sus propinas digitales ya cobradas (viaje revertido).
      // SOLO si el reverso de la TARIFA ya CONFIRMÓ (COMPLETED: cash + direct-sync). Si es ASYNC (queda APPROVED),
      // lo hace el callback CONFIRMED (applyRefundWebhookResult).
      if (isFullyRefunded && result.status === RefundStatus.COMPLETED) {
        await this.refundTripTipsFully(payment.tripId, refund.reason);
      }
      return result;
    } catch (err) {
      // Carrera: otra acción movió la solicitud de PENDING entre el read y el CAS (doble-approve, o un reject
      // concurrente) → devolver el estado vigente (idempotente, sin re-desembolsar).
      if (err instanceof ConcurrencyConflictError) {
        const fresh = await this.repo.findRefundById(refundId);
        if (fresh && fresh.status !== RefundStatus.PENDING) {
          return { refundId, paymentId: fresh.paymentId, status: fresh.status };
        }
      }
      throw err;
    }
  }

  /**
   * COLA DE APROBACIÓN — RECHAZAR una solicitud PENDING (money-OUT). NO mueve plata (la solicitud nunca reservó el
   * cobro) → sin compensación. Persiste el `motivo` del operador en `failureReason` (distinto de `reason`, el motivo
   * del pedido). Idempotente por CAS: un doble-submit ve count=0. SOLO una solicitud PENDING se rechaza — una APPROVED
   * ya está en el riel (la compensa el callback del proveedor, no el operador); COMPLETED es terminal.
   */
  async rejectRefund(
    refundId: string,
    operator: AuthenticatedUser,
    reason: string,
  ): Promise<{ refundId: string; paymentId: string; status: string }> {
    const refund = await this.repo.findRefundById(refundId);
    if (!refund) throw new NotFoundError('Reembolso no encontrado');
    if (refund.status === RefundStatus.REJECTED) {
      return { refundId, paymentId: refund.paymentId, status: refund.status }; // idempotente
    }
    if (refund.status !== RefundStatus.PENDING) {
      throw new InvalidStateError(
        `Solo una solicitud PENDIENTE puede rechazarse (estado actual: ${refund.status})`,
      );
    }
    assertRefundTransition('PENDING', 'REJECTED');
    const claimed = await this.repo.rejectPendingRefund(refundId, {
      status: RefundStatus.REJECTED,
      failureReason: reason,
      approvedBy: operator.userId,
    });
    if (claimed.count === 0) {
      // Carrera: otra acción ya la movió de PENDING → devolver el estado vigente (idempotente).
      const fresh = await this.repo.findRefundById(refundId);
      return {
        refundId,
        paymentId: fresh?.paymentId ?? refund.paymentId,
        status: fresh?.status ?? RefundStatus.REJECTED,
      };
    }
    return { refundId, paymentId: refund.paymentId, status: RefundStatus.REJECTED };
  }

  /**
   * Página de la cola de reembolsos para el admin (filtro por estado opcional + cursor por id DESC). Devuelve la
   * fila Refund con su Payment (tripId/passengerId/method salen del cobro por FK); el shaping PII-consciente + la
   * resolución del nombre del pasajero viven en el admin-bff. `limit+1` deriva el `nextCursor` sin COUNT.
   */
  async listRefundsForAdmin(params: {
    status?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ items: RefundWithPayment[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
    const status = this.parseRefundStatusFilter(params.status);
    const rows = await this.repo.findRefundsForAdmin({ status, cursorId: params.cursor, limit });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null };
  }

  /** Detalle admin de un reembolso (con su Payment para el saldo). Lanza NotFound si no existe. */
  async getRefundForAdmin(id: string): Promise<RefundWithPayment> {
    const refund = await this.repo.findRefundWithPaymentById(id);
    if (!refund) throw new NotFoundError('Reembolso no encontrado');
    return refund;
  }

  /**
   * KPIs de la cabecera de la cola (money-OUT). `requestedCount`/`approvedCount` = conteos por estado. `processedTodayCents`
   * = suma de refunds COMPLETED con `updatedAt` desde el inicio del día (UTC). `refundRatePct` = % de cobros FARE
   * ever-capturados que terminaron reembolsados (PARTIALLY_REFUNDED|REFUNDED); null si no hay cobros capturados
   * (degradación honesta — no se inventa una tasa sin denominador).
   */
  async getRefundStats(): Promise<{
    requestedCount: number;
    approvedCount: number;
    processedTodayCents: number;
    refundRatePct: number | null;
  }> {
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);
    const [requestedCount, approvedCount, processedTodayCents, capturedCount, refundedCount] =
      await Promise.all([
        this.repo.countRefundsByStatus(RefundStatus.PENDING),
        this.repo.countRefundsByStatus(RefundStatus.APPROVED),
        this.repo.sumCompletedRefundAmountSince(startOfToday),
        // Denominador: cobros FARE que SE capturaron alguna vez (capturados + los que luego se reembolsaron).
        this.repo.countPaymentsInStatuses({
          in: ['CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED'],
        }),
        // Numerador: cobros FARE que terminaron (parcial o totalmente) reembolsados.
        this.repo.countPaymentsInStatuses({ in: ['PARTIALLY_REFUNDED', 'REFUNDED'] }),
      ]);
    const refundRatePct =
      capturedCount > 0 ? Math.round((refundedCount / capturedCount) * 1000) / 10 : null;
    return { requestedCount, approvedCount, processedTodayCents, refundRatePct };
  }

  /** Narrowing del filtro de estado de la cola (query string → enum). Un valor inválido se ignora (lista sin filtro). */
  private parseRefundStatusFilter(status?: string): RefundStatus | undefined {
    if (!status) return undefined;
    return (Object.values(RefundStatus) as string[]).includes(status)
      ? (status as RefundStatus)
      : undefined;
  }

  /**
   * F3c-payment · Refund SYSTEM-INITIATED por `booking.cancelled` (ADR-014 §6 camino infeliz). El consumer lo
   * llama cuando un booking se canceló POST-captura (razon ASIENTO_LLENO u OFERTA_NO_DISPONIBLE): el cobro SÍ
   * capturó pero el pasajero NO viajó → hay que devolverle TODO. Diferencias DELIBERADAS con `refund()` admin:
   *
   *  - SIN operador → SIN gate L2: lo dispara el SISTEMA, autoridad total, NO es un refund discrecional de
   *    soporte. El gate >S/30 (RBAC L1/L2) protege la DISCRECIONALIDAD humana; acá no hay discreción que limitar.
   *  - SIN ventana de 7 días: ese límite es para refunds admin discrecionales (anti-abuso de soporte). El
   *    asiento-lleno es un refund OBLIGATORIO e INMEDIATO — el pasajero pagó y no viajó, devolverle SIEMPRE,
   *    sin importar cuándo llegue el `booking.cancelled` (puede llegar reordenado tras un retry de Kafka).
   *  - Refund SIEMPRE FULL: el monto = saldo reembolsable del Payment (`amountCents − refundedCents`). El
   *    pasajero no recibió NADA del servicio → se le devuelve TODO lo que quede sin reembolsar.
   *  - IDEMPOTENCIA DURA: `dedupKey` determinista (`booking-cancel-refund:{bookingId}`, UNIQUE en Refund). Un
   *    evento duplicado/reordenado → P2002 → no-op graceful. Junto al dedup por eventId del consumer = doble
   *    barrera contra el doble-refund (plata real, §2 del plan).
   *
   * Reusa el MISMO core que el refund admin (`executeRefundClaim`): branch CASH/gateway, intent persistido,
   * `payment.refunded` en la tx — sin duplicar lógica y sin tocar el camino admin.
   *
   * Devuelve `{ skipped: true, motivo }` (no error) en los casos VÁLIDOS bajo at-least-once/reorden:
   *   · no hay Payment reembolsable (el cobro no capturó, ya está REFUNDED, o el evento llegó antes que la
   *     captura) → el consumer loguea y avanza el offset (NO relanza: no es una falla).
   *   · ya existe un refund de ESTA cancelación (dedupKey duplicado) → la plata ya volvió, no-op.
   */
  async refundForBookingCancellation(
    tripId: string,
    reason: string,
  ): Promise<
    { refundId: string; paymentId: string; status: string } | { skipped: true; motivo: string }
  > {
    // tripId = bookingId (UUID opaco · §5.5). Mismo lookup que refund(): un cobro CAPTURED o ya parcialmente
    // reembolsado. Si no hay → el cobro no capturó / ya se reembolsó / el evento se adelantó a la captura.
    const payment = await this.findRefundablePaymentByTrip(tripId);
    if (!payment) {
      return {
        skipped: true,
        motivo: 'sin cobro reembolsable (no capturó, ya reembolsado, o evento antes de la captura)',
      };
    }

    // Refund FULL: el saldo que quede sin reembolsar. El pasajero no viajó → se le devuelve TODO.
    const remainingCents = payment.amountCents - payment.refundedCents;
    if (remainingCents <= 0) {
      // Ya totalmente reembolsado (un `booking.cancelled` previo ya lo cubrió, o un refund admin) → no-op.
      return { skipped: true, motivo: 'el cobro ya está totalmente reembolsado' };
    }

    // FULL refund → el Payment queda REFUNDED (no quedará saldo). SIN gate L2, SIN ventana (system-initiated).
    const newRefundedCents = payment.refundedCents + remainingCents;
    assertPaymentTransition(payment.status, 'REFUNDED');

    const claim: RefundClaim = {
      amountCents: remainingCents,
      reason,
      requestedBy: SYSTEM_OPERATOR,
      approvedBy: SYSTEM_OPERATOR,
      // Barrera DURA: un `booking.cancelled` duplicado choca contra el UNIQUE → P2002 → no-op graceful.
      dedupKey: deriveBookingCancellationRefundDedupKey(tripId),
      newStatus: 'REFUNDED',
      newRefundedCents,
      isFullyRefunded: true,
      // RC18 · una cancelación de reserva NO es culpa del conductor (asiento lleno / oferta no disponible) → sin
      // clawback: la plataforma absorbe el reverso, no se le cobra al conductor.
      clawbackDriver: false,
    };

    try {
      const result = await this.executeRefundClaim(payment, claim);
      // A1 · el viaje se revirtió (cancelación) → devolver también sus propinas digitales ya cobradas. SOLO si el
      // reverso de la tarifa CONFIRMÓ (COMPLETED); si es ASYNC (PENDING) lo hace el callback CONFIRMED (ver arriba).
      if (result.status === RefundStatus.COMPLETED) {
        await this.refundTripTipsFully(tripId, reason);
      }
      return result;
    } catch (err) {
      // IDEMPOTENCIA: el dedupKey ya existe (otra entrega del MISMO `booking.cancelled` ya creó el Refund) →
      // P2002 → la plata YA volvió, no-op graceful. Cualquier otro error se relanza (transitorio → reintento).
      if (isUniqueViolation(err, 'dedupKey')) {
        this.logger.log(
          `Refund de cancelación ya existente para el booking ${tripId} (dedupKey); no-op idempotente`,
        );
        return { skipped: true, motivo: 'refund de esta cancelación ya registrado (idempotente)' };
      }
      throw err;
    }
  }

  /**
   * CORE COMPARTIDO del refund (admin y system-initiated): branch TIPADO por método. El efectivo nunca pasó
   * por el gateway → devolución local explícita; lo digital va por el reverso real del proveedor. NO valida
   * (la validación —saldo, ventana, rol, monto— ya la hizo el caller y la cristalizó en el `RefundClaim`).
   */
  private executeRefundClaim(
    payment: Payment,
    claim: RefundClaim,
  ): Promise<{ refundId: string; paymentId: string; status: string }> {
    if (payment.method === 'CASH') {
      return this.refundCashLocally(payment, claim);
    }
    return this.refundViaGateway(payment, claim);
  }

  /**
   * A1 · Cuando un viaje se reembolsa TOTAL (revertido), sus propinas DIGITALES ya cobradas también se devuelven:
   * el pasajero no viajó → no paga la propina. Reembolsa cada tip-Payment CAPTURED del viaje por el reverso real
   * del proveedor (executeRefundClaim), idempotente por `tip-refund:<tipId>`. Best-effort per-tip: un fallo al
   * reembolsar UNA propina NO aborta el refund de la tarifa (queda su marcador durable + log para soporte). Un
   * tip-Payment PENDING (checkout sin completar) no se cobró → no entra (el filtro es CAPTURED/PARTIALLY_REFUNDED).
   */
  private async refundTripTipsFully(tripId: string, reason: string): Promise<void> {
    // El refund de la TARIFA ya se cristalizó ANTES de llamar acá: reembolsar la propina es una operación
    // SECUNDARIA que NUNCA debe abortar/revertir el refund de la tarifa. Si listar las propinas falla → log
    // y salimos (soporte reconcilia); no relanzamos (best-effort, degradación honesta).
    let tips: Payment[];
    try {
      tips = await this.repo.findTripTips(tripId);
    } catch (err) {
      // ERROR (no warn): sin el listado, NINGUNA propina del viaje revertido se reembolsa → posible sobre-cobro.
      // Visible para alerta hasta que el backstop de reconciliación (follow-up A1) lo barra.
      this.logger.error(
        `No se pudieron listar las propinas del viaje ${tripId} para reembolso: ${
          err instanceof Error ? err.message : String(err)
        } (reconciliar)`,
      );
      return;
    }
    // Propinas PENDING (checkout abierto/en curso) al revertirse el viaje: se CANCELAN para que un webhook/poll
    // TARDÍO no las capture sobre un viaje ya reembolsado (el conductor cobraría propina de un viaje que no fue).
    // UN solo updateMany por todas (no N updates uno-por-uno): el `failureReason` es el mismo y el CAS por-fila
    // `status: 'PENDING'` en el WHERE preserva la semántica — una propina que capturó concurrentemente NO matchea
    // (queda CAPTURED, borde a reconciliar). No emite `payment.failed` (propina opcional, no una falla del viaje).
    // Best-effort: un fallo del batch NO aborta el refund de la TARIFA (ya cristalizado antes de entrar acá).
    const pendingTipIds = tips.filter((t) => t.status === 'PENDING').map((t) => t.id);
    if (pendingTipIds.length > 0) {
      try {
        await this.repo.cancelPendingTips(pendingTipIds, `tip-of-refunded-trip: ${reason}`);
      } catch (err) {
        this.logger.warn(
          `No se pudieron cancelar ${pendingTipIds.length} propina(s) PENDING del viaje ${tripId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    // Propinas ya COBRADAS (CAPTURED/PARTIALLY_REFUNDED) → reembolso per-tip: `executeRefundClaim` llama al
    // proveedor y es idempotente por dedupKey, así que es inherentemente por-item (no se batchea). Best-effort.
    for (const tip of tips) {
      if (tip.status === 'PENDING') continue; // ya canceladas en el batch de arriba
      const remainingCents = tip.amountCents - tip.refundedCents;
      if (remainingCents <= 0) continue;
      const claim: RefundClaim = {
        amountCents: remainingCents,
        reason: `tip-of-refunded-trip: ${reason}`,
        requestedBy: SYSTEM_OPERATOR,
        approvedBy: SYSTEM_OPERATOR,
        dedupKey: deriveTipRefundDedupKey(tip.id),
        newStatus: 'REFUNDED',
        newRefundedCents: tip.amountCents,
        isFullyRefunded: true,
        // RC18 · una propina (kind=TIP) NO se clawbackea (el guard kind=FARE de applyRefundClawbackInTx igual lo excluye).
        clawbackDriver: false,
      };
      try {
        await this.executeRefundClaim(tip, claim);
        this.logger.log(`Propina ${tip.id} del viaje ${tripId} reembolsada (viaje revertido)`);
      } catch (err) {
        // Idempotente: ya reembolsada (dedupKey P2002) → no-op. Otro error → log y seguir: NO abortar el
        // refund de la TARIFA por un fallo al devolver una propina (queda para reintento/soporte).
        if (isUniqueViolation(err, 'dedupKey')) continue;
        // ERROR (no warn): una propina que quedó SIN reembolsar sobre un viaje revertido = pasajero sobre-cobrado.
        // Debe ser VISIBLE para alerta/soporte hasta que el backstop de reconciliación (follow-up A1) lo barra.
        this.logger.error(
          `PROPINA SIN REEMBOLSAR sobre viaje revertido — tip=${tip.id} viaje=${tripId}: ${
            err instanceof Error ? err.message : String(err)
          } (reconciliar: pasajero sobre-cobrado)`,
        );
      }
    }
  }

  /**
   * A2 · Al reembolsar un cobro CASH, REVIERTE la deuda de comisión acumulada: el viaje se revirtió → el conductor
   * NO debe la comisión de un viaje que no ocurrió. Reduce la deuda PENDING por el monto reembolsado (la plataforma
   * absorbe el refund de su comisión, mismo modelo que el parcial digital); si llega a 0 la marca REVERSED. Va en la
   * MISMA tx del refund (atomicidad). Si la deuda YA se neteó en un payout (SETTLED), NO se toca acá — sería un
   * credit-back al conductor (edge, follow-up); PENDING es el caso común (refund antes de la liquidación semanal).
   */
  private async reverseCashDebtInTx(
    tx: PaymentTx,
    paymentId: string,
    refundAmountCents: number,
    grossCents: number,
  ): Promise<void> {
    const debt = await this.repo.findDriverDebtByPaymentInTx(tx, paymentId);
    if (!debt) return;

    // Comisión a REVERTIR = PROPORCIONAL a la fracción de tarifa reembolsada (la comisión CASH es un % del bruto).
    // Antes se comparaba `deuda − refundAmount` (comisión vs tarifa, unidades DISTINTAS): un refund PARCIAL
    // reversaba la comisión ENTERA → la plataforma se auto-perdonaba comisión que el conductor SÍ debía sobre la
    // parte del viaje que se mantuvo. grossCents>0 siempre (un cobro con deuda tuvo bruto); cap a la deuda.
    const reversedCents =
      grossCents > 0
        ? Math.min(
            debt.amountCents,
            Math.round((debt.amountCents * refundAmountCents) / grossCents),
          )
        : debt.amountCents;
    if (reversedCents <= 0) return;

    // PENDING (caso común: el refund ocurre ANTES del run de netting): la deuda aún no se cobró → se reduce/anula
    // en el acto, sin mover plata (nunca entró al payout).
    if (debt.status === 'PENDING') {
      const remaining = debt.amountCents - reversedCents;
      if (remaining <= 0) {
        await this.repo.updateDriverDebtInTx(tx, debt.id, {
          status: 'REVERSED',
          amountCents: 0,
          settledAt: new Date(),
        });
      } else {
        await this.repo.updateDriverDebtInTx(tx, debt.id, { amountCents: remaining });
      }
      return;
    }

    // SETTLED (edge · gate MEDIA #4): la deuda YA se neteó en un payout PASADO → el conductor ya pagó esa
    // comisión. Revertir el viaje significa que no la debía → se le ACREDITA lo reversado (PROPORCIONAL) con un
    // DriverCredit que el próximo payout SUMA al neto (applyDebtNetting). Idempotente por source_payment_id
    // @unique. La deuda pasa a REVERSED (traza; el crédito lleva el monto). Antes esto era un no-op → sobre-cobro.
    if (debt.status === 'SETTLED') {
      await this.repo.createDriverCreditInTx(tx, {
        id: uuidv7(),
        driverId: debt.driverId,
        tripId: debt.tripId,
        amountCents: reversedCents,
        sourcePaymentId: paymentId,
        status: 'PENDING',
      });
      await this.repo.updateDriverDebtInTx(tx, debt.id, {
        status: 'REVERSED',
        settledAt: new Date(),
      });
      return;
    }
    // REVERSED → ya revertida (refund re-entregado o 2do refund sobre el mismo cobro) → no-op idempotente.
  }

  /**
   * MATERIALIZA el Refund DENTRO de la tx de la reserva: si el claim trae `existingRefundId` (APROBACIÓN de una
   * solicitud PENDING) la transiciona PENDING → `status` por CAS (count=0 ⇒ carrera → ConcurrencyConflict, la tx
   * se revierte con la reserva); si NO (refund AUTO system-initiated / propina), CREA la fila directamente en
   * `status`. Un ÚNICO punto para las dos entradas al desembolso — sin duplicar lógica ni tocar los call-sites.
   */
  private async materializeRefundInTx(
    tx: PaymentTx,
    payment: Pick<Payment, 'id'>,
    claim: RefundClaim,
    status: RefundStatus,
  ): Promise<Refund> {
    if (claim.existingRefundId) {
      const claimed = await this.repo.casApproveRefundFromPending(tx, claim.existingRefundId, {
        status,
        approvedBy: claim.approvedBy,
      });
      if (claimed.count === 0) {
        throw new ConcurrencyConflictError(
          'La solicitud de reembolso ya no está PENDIENTE (aprobada/rechazada en paralelo)',
        );
      }
      return this.repo.findRefundByIdInTx(tx, claim.existingRefundId);
    }
    return this.repo.createRefundInTx(tx, {
      id: uuidv7(),
      paymentId: payment.id,
      amountCents: claim.amountCents,
      requestedBy: claim.requestedBy,
      approvedBy: claim.approvedBy,
      dedupKey: claim.dedupKey,
      status,
      reason: claim.reason,
      // RC18 · refund AUTO (system-initiated / propina): persiste la causa; `completeRefund` la evalúa al confirmar.
      clawbackDriver: claim.clawbackDriver,
    });
  }

  /** Devolución LOCAL de un cobro CASH (la plata nunca pasó por el riel): COMPLETED + evento en una tx. */
  private async refundCashLocally(
    payment: Payment,
    claim: RefundClaim,
  ): Promise<{ refundId: string; paymentId: string; status: string }> {
    return this.repo.runInTransaction(async (tx) => {
      await this.claimRefundReservationInTx(tx, payment, claim);
      // A2 · revertir la deuda de comisión CASH del conductor, PROPORCIONAL a lo reembolsado (grossCents da la
      // fracción; un refund parcial revierte solo la comisión de la parte devuelta, no la entera).
      await this.reverseCashDebtInTx(tx, payment.id, claim.amountCents, payment.grossCents);
      // CASH: devolución FUERA del riel (soporte la entrega/transfiere) → COMPLETED en el acto (aprobar CASH salta
      // APPROVED: PENDING → COMPLETED directo cuando es una solicitud aprobada; o nace COMPLETED si es AUTO).
      // RC18 · el clawback digital NO aplica a CASH (el efectivo tiene su propia reversa de comisión) y este camino
      // NO pasa por completeRefund; `clawbackDriver` igual se persiste (materializeRefundInTx) por consistencia.
      const refund = await this.materializeRefundInTx(tx, payment, claim, RefundStatus.COMPLETED);
      await this.enqueueRefundedEventInTx(tx, payment, refund);
      return { refundId: refund.id, paymentId: payment.id, status: refund.status };
    });
  }

  private async refundViaGateway(
    payment: Payment,
    claim: RefundClaim,
  ): Promise<{ refundId: string; paymentId: string; status: string }> {
    // Capacidad del adapter (ISP del puerto): sin `Refundable` NO hay riel por donde devolver la plata.
    // Error tipado explícito — JAMÁS marcar REFUNDED sin que el proveedor mueva el dinero (S5).
    if (!supportsRefund(this.gateway)) {
      // ANTES de lanzar: dejar una TRAZA DURABLE (Refund REJECTED de marca) para que el pasajero no quede
      // sin refund Y sin rastro en DB. Best-effort: si falla la marca NO tapa el throw original (el consumer
      // igual clasifica unrecoverable, alerta y mide). Tres trazas: row REJECTED + métrica + log.
      await this.persistUnrecoverableRefundMarker(
        payment,
        claim,
        `${UNRECOVERABLE_REFUND_FAILURE_PREFIX}gateway-sin-reembolsos`,
      ).catch((e) =>
        this.logger.error(
          { err: e },
          'no se pudo persistir el marcador durable del refund unrecoverable (gateway sin reembolsos)',
        ),
      );
      throw new InvalidStateError(
        'El gateway de pagos activo no soporta reembolsos digitales; no se puede devolver la plata por el riel',
      );
    }
    // Referencia del cobro en el riel (uid del proveedor): sin ella el reverso no se puede correlacionar.
    const railRef = payment.externalRef ?? payment.externalUid;
    if (!railRef) {
      await this.persistUnrecoverableRefundMarker(
        payment,
        claim,
        `${UNRECOVERABLE_REFUND_FAILURE_PREFIX}cobro-sin-railRef`,
      ).catch((e) =>
        this.logger.error(
          { err: e },
          'no se pudo persistir el marcador durable del refund unrecoverable (cobro sin railRef)',
        ),
      );
      throw new InvalidStateError(
        'El cobro no tiene referencia del riel; no se puede reembolsar por el gateway',
      );
    }

    // 1) RESERVA + INTENT persistidos ANTES de llamar al proveedor (§4): el CAS bloquea refunds
    //    concurrentes sobre el mismo saldo y el Refund APPROVED es el registro durable del desembolso EN VUELO
    //    (reserva tomada, reverso al riel esperando confirmación). Si es la aprobación de una solicitud, materialize
    //    transiciona la PENDING → APPROVED por CAS; si es AUTO, crea la fila APPROVED.
    const refund = await this.repo.runInTransaction(async (tx) => {
      await this.claimRefundReservationInTx(tx, payment, claim);
      // RC18 · `clawbackDriver` viaja en el claim y lo persiste materializeRefundInTx; completeRefund lo evalúa al confirmar.
      return this.materializeRefundInTx(tx, payment, claim, RefundStatus.APPROVED);
    });

    // 2) Reverso REAL en el proveedor, con la idempotency key derivada de la operación (§4).
    let result: RefundResult;
    try {
      result = await this.gateway.refund(railRef, claim.amountCents, {
        idempotencyKey: deriveRefundIdempotencyKey(refund.id),
      });
    } catch (err) {
      // TIMEOUT/red ≠ FALLA (§4): no sabemos si el proveedor recibió el reverso. NO compensamos ni
      // marcamos REJECTED; el Refund queda PENDING (reserva en pie) y lo cierra el callback del
      // proveedor o la conciliación. NO se re-llama a ciegas (ProntoPaga sin idempotencia de reverso).
      this.logger.error(
        { err },
        `Reverso ${refund.id} (pago ${payment.id}) sin respuesta del proveedor; queda PENDING a confirmar`,
      );
      return { refundId: refund.id, paymentId: payment.id, status: RefundStatus.PENDING };
    }

    // uid del reverso PERSISTIDO APENAS LLEGA, ANTES de procesar el desenlace: es la ÚNICA clave de
    // correlación del callback (urlCallbackRefund → applyRefundWebhookResult). Si se persistiera después
    // (o solo dentro de la tx de completar), un callback rápido o un fallo transitorio posterior dejaría
    // el Refund sin uid → NO_MATCH → PENDING para siempre. Si aun así el callback gana esta escritura,
    // applyRefundWebhookResult responde no-2xx (NotFoundError) y el retry del proveedor correlaciona.
    if (result.externalRefundId) {
      await this.repo.setRefundExternalId(refund.id, result.externalRefundId);
    }

    switch (result.status) {
      case 'ACCEPTED': {
        // Confirmación SÍNCRONA del proveedor → completar y emitir payment.refunded (push al pasajero).
        await this.completeRefund(refund.id, result.externalRefundId ?? null);
        return { refundId: refund.id, paymentId: payment.id, status: RefundStatus.COMPLETED };
      }
      case 'PENDING': {
        // Asíncrono (ProntoPaga): el uid ya quedó persistido arriba; la notificación al pasajero sale
        // recién cuando el callback confirme (applyRefundWebhookResult).
        this.logger.log(
          `Reverso ${refund.id} ACEPTADO por el proveedor (uid=${result.externalRefundId ?? '-'}); espera confirmación`,
        );
        return { refundId: refund.id, paymentId: payment.id, status: RefundStatus.PENDING };
      }
      case 'REJECTED': {
        // Rechazo REAL del proveedor: compensar la reserva (la plata nunca se movió) y fallar honesto.
        await this.rejectRefundAndCompensate(refund.id, result.reason ?? 'reverse_rejected');
        throw new UnprocessableEntityError(
          `El proveedor rechazó el reembolso: ${result.reason ?? 'sin motivo informado'}`,
        );
      }
    }
  }

  /**
   * CAS TRANSACCIONAL (BR-P06, idempotencia financiera #3): reclama el cobro SOLO si sigue reembolsable
   * Y `refundedCents` no cambió desde el read (optimistic lock). Cierra la carrera de refunds parciales/
   * totales concurrentes — bajo READ COMMITTED el 2do bloquea en el row-lock; al re-evaluar el WHERE
   * (refundedCents ya incrementado) obtiene count===0. Sin esto, dos refunds sumaban doble plata.
   * Para el camino DIGITAL esto es una RESERVA: si el proveedor rechaza el reverso, se compensa
   * (rejectRefundAndCompensate); el evento/push al pasajero NUNCA sale de la reserva, solo de la confirmación.
   */
  private async claimRefundReservationInTx(
    tx: PaymentTx,
    payment: Payment,
    claim: RefundClaim,
  ): Promise<void> {
    // Backstop de idempotencia por VENTANA (solo refund admin discrecional): bajo un advisory lock por paymentId,
    // si ya hay un refund reciente del MISMO (paymentId, céntimos) → lanza DuplicateRefundInWindowError (refund()
    // la atrapa y devuelve el existente). El system-initiated NO lo lleva (claim.enforceWindowDedup undefined).
    if (claim.enforceWindowDedup) {
      await this.assertNoDuplicateAdminRefundInWindowTx(tx, payment.id, claim.amountCents);
    }
    const claimed = await this.repo.casClaimRefundReservation(tx, payment.id, payment.refundedCents, {
      status: claim.newStatus,
      refundedCents: claim.newRefundedCents,
      refundedAt: claim.isFullyRefunded ? new Date() : null,
    });
    if (claimed.count === 0) {
      // CAS miss (optimistic-lock): otro refund concurrente movió el saldo entre el read y este write.
      // Es TRANSITORIO (un reintento con el estado fresco tendría éxito), NO una violación PERMANENTE de
      // la máquina de estados → ConcurrencyConflictError, para que el clasificador lo trate como `transient`
      // (Kafka reintenta) y NO dispare la falsa alerta de backstop irrecuperable de InvalidStateError.
      throw new ConcurrencyConflictError(
        'El cobro cambió de saldo por una operación concurrente (CAS); reintentable',
      );
    }
  }

  /**
   * Backstop server-side de idempotencia por VENTANA TEMPORAL (refund admin). Corre DENTRO de la tx del claim,
   * tras tomar un advisory lock TRANSACCIONAL por paymentId (`pg_advisory_xact_lock`) que SERIALIZA los refunds
   * concurrentes del mismo pago — sin él, dos submits simultáneos con keys divergentes pasarían ambos el chequeo
   * (TOCTOU) y doble-pagarían. Con el lock tomado, busca un refund NO-RECHAZADO del MISMO (paymentId, céntimos)
   * creado dentro de la ventana; si existe, lanza `DuplicateRefundInWindowError` (la atrapa `refund()` → devuelve
   * el existente). REJECTED NO cuenta (no movió plata; un reintento tras un rechazo debe poder volver a intentar).
   */
  private async assertNoDuplicateAdminRefundInWindowTx(
    tx: PaymentTx,
    paymentId: string,
    amountCents: number,
  ): Promise<void> {
    // Advisory lock transaccional (se libera SOLO al cerrar la tx): hashtext(paymentId) → clave bigint estable.
    // `$executeRaw` (no `$queryRaw`): pg_advisory_xact_lock devuelve `void` y $queryRaw fallaría al deserializar
    // esa columna; $executeRaw ejecuta la sentencia sin deserializar el resultado.
    await this.repo.acquirePaymentAdvisoryLock(tx, paymentId);
    const since = new Date(Date.now() - this.refundIdempotencyWindowMs);
    const recent = await this.repo.findRecentRefundInWindowInTx(tx, paymentId, amountCents, since);
    if (recent) {
      throw new DuplicateRefundInWindowError({
        refundId: recent.id,
        paymentId: recent.paymentId,
        status: recent.status,
      });
    }
  }

  /**
   * MARCADOR DURABLE de un refund system-initiated IRRECUPERABLE (FIX 1 · invariante sagrado). El refund
   * automático abortó ANTES de mover plata (gateway sin reembolsos / cobro sin railRef) → NO existiría
   * ningún Refund row → sin esto el pasajero quedaría sin refund Y sin traza en DB (solo un log que nadie
   * grepea). Persistimos un Refund REJECTED de marca con `failureReason` estructurado (`unrecoverable:<causa>`):
   *
   *  - status REJECTED ⇒ NO participa del UNIQUE PARCIAL (índice WHERE status <> REJECTED) → SIEMPRE insertable,
   *    incluso en un re-delivery/reintento del mismo `booking.cancelled` (jamás choca P2002, no envenena la key).
   *  - lleva el `dedupKey` system-initiated ⇒ el admin lo CORRELACIONA al booking para disparar el refund admin
   *    manual sobre el Payment CAPTURED (no hay re-conductor automático: el backstop es humano + alerta).
   *  - NO reclama/reserva el Payment (no hay movimiento de plata, es un marcador de FALLO) → el Payment queda
   *    CAPTURED, sigue reembolsable por un admin a mano (que es EXACTAMENTE el backstop). Cero doble-refund.
   *
   * El admin lo VE en cualquier listado de Refunds filtrado por status=REJECTED (el `failureReason` con prefijo
   * `unrecoverable:` lo distingue de un rechazo del proveedor). Best-effort: el caller hace `.catch(log)` y NO
   * deja que un fallo de la marca tape el throw original.
   */
  private async persistUnrecoverableRefundMarker(
    payment: Pick<Payment, 'id'>,
    claim: RefundClaim,
    failureReason: string,
  ): Promise<void> {
    // APROBACIÓN de una solicitud existente: NO se crea un marcador aparte — se transiciona la MISMA solicitud
    // PENDING → REJECTED con el motivo estructurado (no reservó plata → sin compensación). El operador la ve
    // rechazada con la causa `unrecoverable:` en la cola.
    if (claim.existingRefundId) {
      await this.repo.rejectPendingRefund(claim.existingRefundId, {
        status: RefundStatus.REJECTED,
        failureReason,
        approvedBy: claim.approvedBy,
      });
      return;
    }
    await this.repo.createRefund({
      id: uuidv7(),
      paymentId: payment.id,
      amountCents: claim.amountCents,
      requestedBy: claim.requestedBy,
      approvedBy: claim.approvedBy,
      status: RefundStatus.REJECTED,
      reason: claim.reason,
      dedupKey: claim.dedupKey,
      failureReason,
    });
  }

  /**
   * payment.refunded por OUTBOX (misma tx, idempotencia financiera BR-P06). Se emite SOLO cuando la
   * plata efectivamente volvió (CASH local o confirmación del proveedor). `amountCents` = lo reembolsado
   * (no el bruto). `passengerId` enriquecido (persistido al cobrar) → push "te devolvimos S/X.XX".
   */
  private async enqueueRefundedEventInTx(
    tx: PaymentTx,
    payment: Pick<Payment, 'id' | 'tripId' | 'passengerId'>,
    refund: Pick<Refund, 'amountCents' | 'reason' | 'approvedBy' | 'requestedBy'>,
  ): Promise<void> {
    const envelope = createEnvelope({
      eventType: 'payment.refunded',
      producer: 'payment-service',
      payload: {
        paymentId: payment.id,
        tripId: payment.tripId,
        amountCents: refund.amountCents,
        reason: refund.reason,
        approvedBy: refund.approvedBy ?? refund.requestedBy,
        passengerId: payment.passengerId ?? undefined,
      },
    });
    await this.repo.enqueueOutbox(tx, envelope, payment.id);
  }

  /**
   * Completa un Refund PENDING → COMPLETED (confirmación del proveedor, síncrona o por callback) y
   * emite payment.refunded en la MISMA transacción. IDEMPOTENTE por CAS (updateMany where status=PENDING):
   * una redelivery del callback no re-emite el evento ni duplica el push. Devuelve si aplicó.
   */
  private async completeRefund(
    refundId: string,
    externalRefundId: string | null,
  ): Promise<boolean> {
    return this.repo.runInTransaction(async (tx) => {
      const claimed = await this.repo.casCompleteRefund(tx, refundId, {
        status: RefundStatus.COMPLETED,
        ...(externalRefundId ? { externalRefundId } : {}),
      });
      if (claimed.count === 0) return false; // ya resuelto (redelivery) → idempotente, sin segundo evento.
      const refund = await this.repo.findRefundWithPaymentInTx(tx, refundId);
      await this.enqueueRefundedEventInTx(tx, refund.payment, refund);
      await this.applyRefundClawbackInTx(tx, refund.payment, refund.clawbackDriver);
      return true;
    });
  }

  /**
   * RC18 (ADR-022) · CLAWBACK CONDICIONAL del neto del conductor. Corre DENTRO de la tx que completa el refund
   * digital (único punto por donde pasan AMBOS rieles: el síncrono `refundViaGateway` ACCEPTED y el asíncrono
   * `applyRefundWebhookResult` CONFIRMED) → la deuda nace atómica con el reverso confirmado, nunca antes de que
   * la plata vuelva.
   *
   * Crea una `DriverDebt` PENDING (reason REFUND_CLAWBACK) por el neto que el conductor cobró de la TARIFA
   * (`gross − commission`), que se netea de su próximo payout (`applyDebtNetting`). SOLO si:
   *  - `clawbackDriver` (causa atribuible al conductor; un dispute/fraude del pasajero → false → la plataforma lo come);
   *  - el pago quedó TOTALMENTE reembolsado (status REFUNDED; un parcial lo absorbe la plataforma de su comisión);
   *  - es una tarifa DIGITAL (method != CASH — el efectivo tiene su propia reversa) con conductor y kind=FARE;
   *  - el conductor YA fue liquidado por ESE viaje: existe un Payout suyo cuyo período cubre el `capturedAt`. Si el
   *    refund ocurre ANTES de la liquidación, `collectEarnings` ya excluye el pago REFUNDED (no se paga) → crear la
   *    deuda ahí sería doble-castigo (deuda por un viaje que el conductor nunca cobró).
   *
   * Idempotente por el UNIQUE(paymentId) de DriverDebt: se chequea la existencia ANTES de crear (no se confía en la
   * violación del UNIQUE, que abortaría la tx del refund en Postgres). El CAS de `completeRefund` ya serializa: un
   * solo camino completa cada refund, así que el check-then-create acá no compite consigo mismo.
   */
  private async applyRefundClawbackInTx(
    tx: PaymentTx,
    payment: Payment,
    clawbackDriver: boolean,
  ): Promise<void> {
    if (!clawbackDriver) return;
    if (payment.status !== 'REFUNDED') return; // solo refund TOTAL
    if (payment.method === 'CASH') return; // el efectivo tiene su propia reversa (reverseCashDebtInTx)
    if (payment.kind !== 'FARE') return; // se clawbackea la tarifa, no una propina
    if (!payment.driverId) return;
    const netCents = payment.grossCents - payment.commissionCents; // lo que el conductor cobró de la tarifa
    if (netCents <= 0) return;

    const capturedAt = payment.capturedAt ?? payment.createdAt;
    const alreadySettled = await tx.payout.findFirst({
      where: {
        driverId: payment.driverId,
        periodStart: { lte: capturedAt },
        periodEnd: { gt: capturedAt },
      },
      select: { id: true },
    });
    if (!alreadySettled) return; // aún no liquidado → el sweep ya excluye el pago REFUNDED; sin clawback.

    const existing = await tx.driverDebt.findUnique({ where: { paymentId: payment.id } });
    if (existing) return; // idempotente: el clawback de este pago ya existe.

    await tx.driverDebt.create({
      data: {
        id: uuidv7(),
        driverId: payment.driverId,
        tripId: payment.tripId,
        paymentId: payment.id,
        amountCents: netCents,
        reason: 'REFUND_CLAWBACK',
        status: 'PENDING',
      },
    });
    this.logger.log(
      `RC18 · clawback ${netCents} céntimos al conductor ${payment.driverId} por refund total del viaje ${payment.tripId} (viaje revertido, causa del conductor)`,
    );
  }

  /**
   * Rechazo del reverso (síncrono o por callback): Refund → REJECTED (con `failureReason` del proveedor)
   * y COMPENSACIÓN de la reserva en el Payment (la plata nunca se movió): refundedCents vuelve a restarse
   * y el estado se restaura (PARTIALLY_REFUNDED si queda algo reembolsado, sino CAPTURED).
   * NOTA: la restauración NO es una transición forward de la máquina de estados (REFUNDED no "avanza" a
   * CAPTURED): es el rollback explícito de una reserva optimista que no se materializó — por eso no pasa
   * por assertPaymentTransition. El CAS sobre el Refund garantiza que UN solo camino compensa.
   *
   * COMPENSACIÓN ATÓMICA (misma disciplina que claimRefundReservationInTx): la resta NO se computa en
   * JS sobre un read previo. Bajo READ COMMITTED, una reserva concurrente (claimRefundReservationInTx)
   * que commitea entre la lectura y el update quedaría PISADA (lost update → refundedCents subcontado →
   * un refund futuro podría superar amountCents = doble salida de plata). El `decrement` se evalúa EN la
   * base sobre la fila ya lockeada por este UPDATE; el row-lock se sostiene hasta el commit de la tx, así
   * que el valor que devuelve es el saldo REAL post-compensación y el segundo update (status/refundedAt
   * derivados de ese saldo) no puede ser interferido por otra transacción.
   *
   * BACKSTOP DEL INVARIANTE SAGRADO (riel COMÚN de rechazo · plata real): este es el ÚNICO punto donde un
   * Refund pasa a REJECTED, y lo alcanzan AMBOS rieles — el SÍNCRONO (refundViaGateway, rechazo inmediato del
   * proveedor) y el ASÍNCRONO (applyRefundWebhookResult, DECLINED/EXPIRED por callback días después). Por eso la
   * métrica scrapeable del backstop (`payment_refund_backstop_total{reason="rejected"}`, sobre la que dispara la
   * alerta de ops) se emite ACÁ y no en el consumer Kafka: si solo viviera en el consumer, el riel async la
   * evadiría (el consumer ya commiteó el offset al ver PENDING=éxito) → un refund system-initiated REJECTED por
   * callback quedaría SIN métrica/alerta/rastro accionable. Se emite SOLO para refunds SYSTEM-INITIATED (los
   * automáticos por `booking.cancelled`, sin operador humano monitoreando) — distinguidos por el prefijo
   * `BOOKING_CANCEL_REFUND_DEDUP_PREFIX` del `dedupKey`. Un refund ADMIN rechazado (dedupKey NULL / otro prefijo)
   * el operador YA lo ve en su UI → no necesita esta señal de backstop. Se emite DESPUÉS del commit y SOLO si el
   * CAS ganó (esta llamada hizo la transición PENDING→REJECTED) → exactamente una vez por refund REJECTED, sin
   * doble conteo con el consumer (al que se le quitó la emisión de `'rejected'`).
   */
  private async rejectRefundAndCompensate(
    refundId: string,
    failureReason: string,
  ): Promise<boolean> {
    const outcome = await this.repo.runInTransaction(async (tx) => {
      const claimed = await this.repo.casRejectRefund(tx, refundId, {
        status: RefundStatus.REJECTED,
        failureReason,
      });
      if (claimed.count === 0) return { applied: false, systemInitiated: false }; // ya resuelto → idempotente.
      const refund = await this.repo.findRefundByIdInTx(tx, refundId);
      // Decremento ATÓMICO en la DB (no read-compute-write): toma el row-lock del Payment y devuelve la
      // fila con el saldo real ya restado, aun si otra reserva commiteó después de nuestro claim.
      const restored = await this.repo.decrementPaymentRefundedInTx(
        tx,
        refund.paymentId,
        refund.amountCents,
      );
      // status/refundedAt derivados del saldo REAL post-decremento. Seguro dentro de la misma tx: el
      // row-lock tomado por el decremento bloquea cualquier escritura concurrente hasta nuestro commit.
      await this.repo.restorePaymentAfterRejectInTx(tx, restored.id, {
        status: restored.refundedCents > 0 ? 'PARTIALLY_REFUNDED' : 'CAPTURED',
        refundedAt: null,
      });
      this.logger.warn(
        `Reverso ${refundId} RECHAZADO por el proveedor (${failureReason}); reserva compensada en el pago ${restored.id}`,
      );
      // SYSTEM-INITIATED ⇔ el dedupKey lleva el prefijo del refund automático por booking.cancelled (cero strings
      // mágicos). Solo esos caen al backstop manual sin humano monitoreando → solo esos emiten la métrica.
      const systemInitiated =
        refund.dedupKey?.startsWith(BOOKING_CANCEL_REFUND_DEDUP_PREFIX) ?? false;
      return { applied: true, systemInitiated };
    });

    // DESPUÉS del commit (el rechazo + compensación ya son durables) y SOLO si ESTA llamada hizo la transición
    // (CAS ganado): emitir la métrica del backstop para refunds system-initiated. Cubre el riel SÍNCRONO y el
    // ASÍNCRONO por un único punto, exactamente una vez, sin doble conteo con el consumer Kafka.
    if (outcome.applied && outcome.systemInitiated) {
      this.metrics?.incRefundBackstop('rejected');
    }
    return outcome.applied;
  }

  /**
   * Aplica el resultado del CALLBACK de reembolso del proveedor (ProntoPaga urlCallbackRefund →
   * POST /webhooks/prontopaga/refund). Correlaciona por `externalRefundId` (uid del reverso, persistido
   * APENAS el proveedor lo devuelve en refundViaGateway). IDEMPOTENTE: las transiciones van por CAS
   * (PENDING→COMPLETED / PENDING→REJECTED); una redelivery no re-emite payment.refunded ni compensa
   * dos veces.
   *
   * SIN MATCH → NotFoundError (no-2xx): el patrón del playbook es responder 2xx SOLO cuando pudimos
   * persistir/correlacionar. Un callback que llega ANTES de que el uid quede persistido (carrera entre
   * la respuesta HTTP de /reverse/new y nuestro update) NO debe absorberse con 200 — eso le diría al
   * proveedor "recibido" y el Refund quedaría PENDING para siempre. Con no-2xx el proveedor REINTENTA
   * la entrega (igual que ante el 401 de firma inválida) y en el retry el uid ya está persistido.
   */
  async applyRefundWebhookResult(input: {
    externalRefundId: string;
    status: WebhookStatus;
  }): Promise<{ applied: boolean; status: string }> {
    const refund = await this.repo.findRefundByExternalRefundId(input.externalRefundId);
    if (!refund) {
      this.logger.warn(
        `Callback de reembolso sin match (uid=${input.externalRefundId}); respondemos no-2xx para que el proveedor reintente`,
      );
      throw new NotFoundError('Reverso no correlacionado todavía; reintente la entrega');
    }
    switch (input.status) {
      case 'CONFIRMED': {
        const applied = await this.completeRefund(refund.id, input.externalRefundId);
        // A1 · el reverso ASYNC de la TARIFA recién CONFIRMÓ acá (no en la reserva) → AHORA se devuelven sus
        // propinas digitales, si fue un refund TOTAL de una FARE. Cierra el bug: antes se devolvían en la reserva
        // y un reverso que se RECHAZABA después las dejaba reembolsadas sobre una tarifa no revertida. `applied`
        // (completeRefund idempotente) → solo el PRIMER callback dispara; refundTripTipsFully ya es idempotente.
        if (applied) {
          const p = await this.repo.findPaymentById(refund.paymentId);
          if (p && p.kind === 'FARE' && p.status === 'REFUNDED') {
            await this.refundTripTipsFully(p.tripId, refund.reason);
          }
        }
        return { applied, status: RefundStatus.COMPLETED };
      }
      case 'DECLINED':
      case 'EXPIRED': {
        const applied = await this.rejectRefundAndCompensate(
          refund.id,
          `reverse_${input.status.toLowerCase()}`,
        );
        return { applied, status: RefundStatus.REJECTED };
      }
      case 'PENDING':
        return { applied: false, status: refund.status }; // sigue en curso → sin transición.
    }
  }

  /**
   * Registra la penalidad de cancelación del pasajero (F2 · BR-T03). trip-service emite `trip.cancelled`
   * con `penaltyCents`; acá la guardamos como obligación PENDING con el split conductor/plataforma. El
   * conductor (si esperó) cobra su parte en el payout al saldarse. Idempotente por `tripId` (@unique):
   * un evento reprocesado devuelve la penalidad existente sin duplicar (ni doble evento).
   */
  async recordCancellationPenalty(input: {
    tripId: string;
    passengerId: string;
    driverId?: string;
    penaltyCents: number;
    reason?: string;
  }): Promise<{ penaltyId: string; status: string }> {
    // Split: el conductor cobra su parte SOLO si hubo conductor (esperó). Sin conductor → todo plataforma.
    const driverCompensationCents = input.driverId
      ? Math.floor(input.penaltyCents * this.cancellationDriverShare)
      : 0;
    const platformCents = input.penaltyCents - driverCompensationCents;

    // Idempotencia: una penalidad por viaje (trip_id @unique). Atajo si ya existe.
    const existing = await this.repo.findPenaltyByTripId(input.tripId);
    if (existing) {
      return { penaltyId: existing.id, status: existing.status };
    }

    const id = uuidv7();
    try {
      return await this.repo.runInTransaction(async (tx) => {
        const penalty = await this.repo.createPenaltyInTx(tx, {
          id,
          tripId: input.tripId,
          passengerId: input.passengerId,
          driverId: input.driverId,
          penaltyCents: input.penaltyCents,
          driverCompensationCents,
          platformCents,
          status: 'PENDING',
          reason: input.reason,
        });
        // Dominó: notification avisa al pasajero ("te cobramos S/X por cancelar"). Misma tx (outbox).
        const envelope = createEnvelope({
          eventType: 'payment.cancellation_penalty_recorded',
          producer: 'payment-service',
          payload: {
            penaltyId: penalty.id,
            tripId: input.tripId,
            passengerId: input.passengerId,
            driverId: input.driverId,
            penaltyCents: input.penaltyCents,
            driverCompensationCents,
            platformCents,
          },
        });
        await this.repo.enqueueOutbox(tx, envelope, penalty.id);
        return { penaltyId: penalty.id, status: 'PENDING' };
      });
    } catch (err) {
      // Carrera: otra réplica creó la penalidad entre el findUnique y el create (P2002 sobre trip_id).
      if (isUniqueViolation(err, 'tripId')) {
        const raced = await this.repo.findPenaltyByTripId(input.tripId);
        if (raced) return { penaltyId: raced.id, status: raced.status };
      }
      throw err;
    }
  }

  /**
   * F2.3 · Saldar una penalidad de cancelación "como un DEBT": el pasajero la paga por el rail. Crea un
   * Payment de LIQUIDACIÓN (dedupKey determinista `cancellation-penalty:${penaltyId}`, driverId=NULL,
   * commission=0) y lo cobra por el MISMO camino que un viaje (processAggregatorCharge/processGatewayCharge).
   * Al capturarse (sync o webhook), `captureSuccess` flippea la penalidad → COLLECTED y libera el gate.
   * ANTI-IDOR: la penalidad debe pertenecer al pasajero autenticado (sino 404, anti-enumeración).
   * Idempotente por la dedupKey del Payment (doble-tap / ya pagando → devuelve el mismo Payment).
   */
  async settleCancellationPenalty(input: {
    penaltyId: string;
    passengerId: string;
    method: PaymentMethod;
    payerRef?: string;
    client?: ChargeInput['client'];
  }): Promise<Payment> {
    // El efectivo no aplica: la penalidad se paga digital (no hay conductor presente post-cancelación
    // para la confirmación bilateral del efectivo).
    if (input.method === 'CASH') {
      throw new InvalidStateError(
        'Una penalidad de cancelación se paga por un medio digital, no en efectivo',
      );
    }
    // MISMO guard de capacidad que charge() (antes duplicado verbatim): el adapter declara su catálogo.
    this.assertGatewaySupportsMethod(input.method);

    const penalty = await this.repo.findPenaltyById(input.penaltyId);
    // Ajena o inexistente → 404 (no 403): no filtramos que exista para otro pasajero (anti-enumeración).
    // `penalty?.passengerId !== <string>` cubre el null (undefined !== string) y la pertenencia en una.
    if (penalty?.passengerId !== input.passengerId) {
      throw new NotFoundError('Penalidad no encontrada');
    }
    if (penalty.status === 'WAIVED') {
      throw new InvalidStateError('Esta penalidad fue perdonada; no hay nada que pagar');
    }

    // Idempotencia: una sola liquidación por penalidad (dedupKey @unique). Si ya existe el Payment de
    // liquidación, devolverlo (ya se está pagando, o ya se pagó y la penalidad quedó COLLECTED).
    const dedupKey = `cancellation-penalty:${penalty.id}`;
    const existing = await this.repo.findPaymentByDedupKey(dedupKey);
    if (existing) return existing;

    let payment: Payment;
    try {
      payment = await this.repo.createPayment({
        id: uuidv7(),
        tripId: penalty.tripId,
        // driverId NULL a propósito: la compensación del conductor NO entra por esta fila (sería doble
        // pago), entra vía collectEarnings sumando la penalidad COLLECTED (F2.3b).
        driverId: null,
        passengerId: penalty.passengerId,
        dedupKey,
        amountCents: penalty.penaltyCents,
        grossCents: penalty.penaltyCents,
        // Una penalidad NO lleva comisión de plataforma: el split (driver/plataforma) ya vive en la
        // penalidad. El Payment de liquidación solo mueve el dinero del pasajero por el rail.
        commissionCents: 0,
        feeCents: 0,
        tipCents: 0,
        method: input.method,
        payerRef: input.payerRef ?? null,
        cancellationPenaltyId: penalty.id,
        status: 'PENDING',
      });
    } catch (err) {
      // Carrera de doble-submit con la misma dedupKey: el UNIQUE garantiza una sola liquidación.
      if (isUniqueViolation(err, 'dedupKey')) {
        const dup = await this.repo.findPaymentByDedupKey(dedupKey);
        if (dup) return dup;
        throw new ConflictError('Liquidación duplicada para la misma penalidad');
      }
      throw err;
    }

    // Cobro por el rail (espejo de charge), según el flujo que DECLARA el adapter: aggregator es
    // ASÍNCRONO (webhook captura → COLLECTED); direct corre el riel con reintentos y captura sync
    // → COLLECTED en captureSuccess.
    return this.dispatchDigitalCharge(payment, {
      tripId: penalty.tripId,
      grossCents: penalty.penaltyCents,
      method: input.method,
      payerRef: input.payerRef,
      dedupKey,
      userId: penalty.passengerId,
      client: input.client,
    });
  }

  /** Cobro disparado por el evento trip.completed (BR-P01). dedupKey determinista por viaje. */
  async chargeFromTripCompleted(input: {
    tripId: string;
    grossCents: number;
    dedupKey: string;
    driverId?: string;
    /**
     * Método de pago del VIAJE (lo elige el pasajero al pedirlo; viaja en el evento trip.completed).
     * El cobro DEBE respetarlo: un viaje CASH se cobra como efectivo (queda PENDING hasta la
     * confirmación bilateral, BR-P03) y NO se auto-captura contra el riel Yape/Plin.
     */
    method?: PaymentMethod;
    /** Código de promoción a canjear (Ola 2A); descuenta del total del pasajero. */
    promoCode?: string;
    /** Pasajero del viaje (requerido para canjear la promo). */
    userId?: string;
    /**
     * EFECTIVO (decisión del dueño): el conductor cobró en mano al TERMINAR el viaje (driverConfirmed
     * del modelo bilateral, BR-P03). Solo aplica si el method efectivo es CASH: se crea la
     * CashConfirmation con driverConfirmed=true y se emite payment.cash_pending para que el PASAJERO
     * confirme (push). Ausente/false ⇒ flujo bilateral normal (driverConfirmed queda false).
     */
    cashCollected?: boolean;
    /** MÉTRICAS · modo de despacho del viaje (FIXED/PUJA) denormalizado del evento — para el corte "Ingresos
     *  por modo" (divide el ON_DEMAND en Fijo/Puja). Ausente en eventos viejos ⇒ null (sin modo). */
    dispatchMode?: string;
    /** MÉTRICAS · origen del viaje (lat/lng) denormalizado del evento — la captura zonifica a distrito para el
     *  corte "Ingresos por distrito". Ausente ⇒ sin geo/distrito. */
    originLat?: number;
    originLng?: number;
  }): Promise<Payment> {
    // Fallback a defaultMethod SOLO para eventos viejos sin el campo (compat. con trip.completed
    // emitidos antes de que trip-service incluyera paymentMethod en el envelope). Para eventos
    // nuevos el método SIEMPRE viene del viaje; el default del env nunca debe sobrescribirlo.
    const method = input.method ?? this.defaultMethod;
    const payment = await this.charge({
      tripId: input.tripId,
      grossCents: input.grossCents,
      tipCents: 0,
      method,
      // El cobro on-demand entra por el evento trip.completed → modo ON_DEMAND (tasa configurable). El
      // carpooling NUNCA pasa por acá: entra por POST /charge service-rail (controller), tageado CARPOOLING.
      mode: ChargeMode.ON_DEMAND,
      driverId: input.driverId,
      dedupKey: input.dedupKey,
      promoCode: input.promoCode,
      userId: input.userId,
      // MÉTRICAS · denormalización para los cortes por modo/distrito (charge las persiste + zonifica el origen).
      dispatchMode: input.dispatchMode,
      originLat: input.originLat,
      originLng: input.originLng,
    });

    // EFECTIVO: el conductor ya confirmó "cobré" al terminar. Aplicamos su lado de la confirmación
    // bilateral de una (idempotente). Solo para CASH y cuando el evento trae cashCollected=true; en
    // digital o sin la señal, el Payment sigue su curso (riel / bilateral normal). Encapsulado para
    // NO romper el camino feliz del cobro: un fallo acá no debe revertir el Payment ya creado.
    if (method === 'CASH' && input.cashCollected === true && payment.status === 'PENDING') {
      try {
        return await this.applyDriverCashConfirmation(payment);
      } catch (err) {
        this.logger.error(
          { err },
          `Falló aplicar la confirmación del conductor (cashCollected) al pago ${payment.id}; queda PENDING bilateral`,
        );
        return payment;
      }
    }
    return payment;
  }

  /**
   * EFECTIVO · aplica la confirmación del CONDUCTOR a un Payment CASH recién creado (driverConfirmed=true),
   * derivada de `cashCollected` en trip.completed. IDEMPOTENTE (upsert por tripId + status-guard):
   *  - Si el PASAJERO ya había confirmado (caso raro: confirmó antes de existir el Payment, vía el upsert
   *    de confirmCash) → ambos true → CAPTURA directo (payment.captured).
   *  - Si solo el conductor confirmó → el Payment queda PENDING y se emite payment.cash_pending para que
   *    notification-service empuje al PASAJERO "confirma tu pago en efectivo". El conductor NO necesita
   *    push (ya confirmó al terminar). Reprocesar el mismo trip.completed no duplica (upsert + dedup outbox).
   */
  private async applyDriverCashConfirmation(payment: Payment): Promise<Payment> {
    const confirmation = await this.repo.upsertCashConfirmation(payment.tripId, {
      driverConfirmed: true,
    });

    // El pasajero ya había confirmado (caso raro) → ambos true → captura inmediata.
    if (confirmation.passengerConfirmed) {
      await this.captureCash(payment);
      return this.getPayment(payment.id);
    }

    // Solo el conductor confirmó → PENDING esperando al pasajero. Emitimos cash_pending (push) por
    // OUTBOX (idempotencia financiera): aggregateId = paymentId, dedup natural del relay.
    await this.repo.runInTransaction(async (tx) => {
      const envelope = createEnvelope({
        eventType: 'payment.cash_pending',
        producer: 'payment-service',
        payload: {
          paymentId: payment.id,
          tripId: payment.tripId,
          grossCents: payment.grossCents,
          // ENRIQUECIDO: destino del push del pasajero (sin join cross-servicio).
          passengerId: payment.passengerId ?? undefined,
        },
      });
      await this.repo.enqueueOutbox(tx, envelope, payment.id);
    });
    this.logger.log(
      `Efectivo ${payment.id} (viaje ${payment.tripId}): conductor confirmó, falta el pasajero → cash_pending`,
    );
    return payment;
  }

  /**
   * Derecho al olvido (Ley 29733, BR-S06) — consumido desde `user.deleted` (S7c). Los registros
   * financieros (payments/refunds/payouts: montos, fechas, estados, ids) se CONSERVAN por obligación
   * legal contable; lo que se ANONIMIZA es la PII del usuario que viaja en ellos: `payerRef`
   * (teléfono/token del pagador en el riel) se sobrescribe con el placeholder irreversible compartido
   * de @veo/database. Idempotente: la sobre-escritura es determinista, reprocesar es un no-op.
   */
  async eraseUserPii(userId: string): Promise<{ paymentsAnonymized: number }> {
    const result = await this.repo.anonymizePayerRef(
      userId,
      deletedPlaceholder(userId, 'payerRef'),
    );
    this.logger.log(
      `Derecho al olvido: payerRef anonimizado en ${result.count} pago(s) del usuario ${userId} ` +
        '(registros financieros conservados por obligación contable)',
    );
    return { paymentsAnonymized: result.count };
  }
}
