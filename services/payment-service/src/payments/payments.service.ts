/**
 * PaymentsService — cobros idempotentes, comisión, reintentos→DEBT, efectivo bilateral y reembolsos.
 * BR-P01..P04, P06. El dinero SIEMPRE en céntimos PEN. Eventos vía OUTBOX (misma transacción).
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createEnvelope } from '@veo/events';
import { deletedPlaceholder, enqueueOutbox, isUniqueViolation } from '@veo/database';
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
import { PrismaService } from '../infra/prisma.service';
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
import { Prisma, RefundStatus, type Payment, type Refund } from '../generated/prisma';
import {
  assertCanAddTip,
  assertPaymentTransition,
  BOOKING_CANCEL_REFUND_DEDUP_PREFIX,
  bpsToRate,
  ChargeMode,
  ADMIN_REFUND_IDEMPOTENCY_WINDOW_MS,
  computeChargeAmounts,
  deriveAdminRefundDedupKey,
  deriveBookingCancellationRefundDedupKey,
  deriveRefundIdempotencyKey,
  retryDelayMs,
} from './payment.policy';
import { CommissionService } from '../commission/commission.service';
import { PaymentMetrics } from '../metrics/payment.metrics';
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
   * Aplica el backstop server-side de idempotencia por VENTANA TEMPORAL sobre (paymentId, céntimos) ANTES de
   * crear el refund (solo el camino ADMIN discrecional). El system-initiated NO lo lleva (tiene su `dedupKey`
   * determinista por bookingId). `false`/undefined = sin backstop de ventana (el operador pidió `forceNew`, o es
   * system-initiated).
   */
  enforceWindowDedup?: boolean;
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
  private readonly refundL2ThresholdCents: number;
  private readonly cancellationDriverShare: number;

  constructor(
    private readonly prisma: PrismaService,
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
    this.refundL2ThresholdCents = config.getOrThrow<number>('REFUND_L2_THRESHOLD_CENTS');
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

    const existing = await this.prisma.read.payment.findUnique({
      where: { dedupKey: input.dedupKey },
    });
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
      payment = await this.prisma.write.payment.create({
        data: {
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
          payerRef: input.payerRef ?? null,
          status: 'PENDING',
        },
      });
    } catch (err) {
      // Carrera de doble-submit con la misma dedupKey: el UNIQUE garantiza un solo pago.
      if (isUniqueViolation(err, 'dedupKey')) {
        const dup = await this.prisma.read.payment.findUnique({
          where: { dedupKey: input.dedupKey },
        });
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
    const updated = await this.prisma.write.payment.update({
      where: { id: payment.id },
      data: {
        externalUid: result.externalRef ?? null,
        checkoutUrl: result.checkout?.urlPay ?? null,
        qrCode: result.checkout?.qrCodeBase64 ?? null,
        deepLink: result.checkout?.deepLink ?? null,
        cip: result.checkout?.cip ?? null,
        checkoutExpiresAt: result.checkout?.expiresAt ? new Date(result.checkout.expiresAt) : null,
      },
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
    return this.prisma.write.$transaction(async (tx) => {
      // CAS atómico: el estado va en el WHERE. Dos entregas del webhook procesadas EN PARALELO leen
      // ambas PENDING (TOCTOU en applyWebhookResult: read en 688 + check en 696); solo la que matchea
      // PENDING→CAPTURED emite payment.captured y colecta la penalidad. La perdedora ve count=0 →
      // devuelve el pago ya capturado SIN duplicar el evento (espeja el guard de collectPenaltyInTx).
      const { count } = await tx.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: {
          status: 'CAPTURED',
          externalRef,
          retries: attempts,
          capturedAt: new Date(),
          failureReason: null,
        },
      });
      const updated = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
      if (count === 0) return updated; // otra entrega ya capturó: no re-emitir ni re-colectar
      const envelope = createEnvelope({
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
      await enqueueOutbox(tx, envelope, updated.id);
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
    tx: Prisma.TransactionClient,
    penaltyId: string,
    settlementPaymentId: string,
  ): Promise<void> {
    const claimed = await tx.cancellationPenalty.updateMany({
      where: { id: penaltyId, status: 'PENDING' },
      data: { status: 'COLLECTED', collectedAt: new Date() },
    });
    if (claimed.count === 0) return; // ya COLLECTED/WAIVED → idempotente, sin segundo evento.
    const penalty = await tx.cancellationPenalty.findUnique({ where: { id: penaltyId } });
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
    await enqueueOutbox(tx, envelope, penalty.id);
  }

  private async markDebt(payment: Payment, reason: string): Promise<Payment> {
    assertPaymentTransition(payment.status, 'DEBT');
    return this.prisma.write.$transaction(async (tx) => {
      const updated = await tx.payment.update({
        where: { id: payment.id },
        data: { status: 'DEBT', retries: this.maxRetries, failureReason: reason },
      });
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
      await enqueueOutbox(tx, envelope, updated.id);
      return updated;
    });
  }

  async getPayment(id: string): Promise<Payment> {
    const payment = await this.prisma.read.payment.findUnique({ where: { id } });
    if (!payment) throw new NotFoundError('Pago no encontrado');
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
    const debtRows = await this.prisma.read.payment.findMany({
      where: { passengerId, status: 'DEBT' },
      select: { id: true, tripId: true, amountCents: true, failureReason: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
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
    const pendingRows = await this.prisma.read.payment.findMany({
      where: { passengerId, status: 'PENDING' },
      select: {
        id: true,
        tripId: true,
        amountCents: true,
        createdAt: true,
        externalUid: true,
        checkoutUrl: true,
        deepLink: true,
        qrCode: true,
        cip: true,
      },
      orderBy: { createdAt: 'asc' },
    });
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
    const penaltyRows = await this.prisma.read.cancellationPenalty.findMany({
      where: { passengerId, status: 'PENDING' },
      select: { id: true, tripId: true, penaltyCents: true, reason: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
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
    const payment = await this.prisma.read.payment.findUnique({ where: { id } });
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
    const claimed = await this.prisma.write.payment.updateMany({
      where: { id, status: 'DEBT' },
      data: { status: 'PENDING', failureReason: null },
    });
    if (claimed.count === 0) {
      // Otro intento concurrente ya lo movió: devolvemos el estado vigente (no-op idempotente).
      return this.getPayment(id);
    }

    const reclaimed = await this.prisma.read.payment.findUnique({ where: { id } });
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
    const payment = await this.prisma.read.payment.findUnique({ where: { id } });
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
    const claimed = await this.prisma.write.payment.updateMany({
      where: { id, status: { in: ['PENDING', 'DEBT'] } },
      data: {
        method,
        status: 'PENDING',
        failureReason: null,
        externalUid: null,
        checkoutUrl: null,
        qrCode: null,
        deepLink: null,
        cip: null,
        checkoutExpiresAt: null,
      },
    });
    if (claimed.count === 0) {
      // Otro intento concurrente ya lo movió (o se capturó entre medio): estado vigente (no-op idempotente).
      return this.getPayment(id);
    }

    const reclaimed = await this.prisma.read.payment.findUnique({ where: { id } });
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
    if (!input.paymentId) {
      // Sin `order` no podemos correlacionar; intentamos por externalUid (defensivo).
      const byUid = await this.prisma.read.payment.findFirst({
        where: { externalUid: input.externalUid },
      });
      if (!byUid) {
        this.logger.warn(`Webhook de pago sin match (uid=${input.externalUid}); no-op`);
        return { applied: false, status: 'NO_MATCH' };
      }
      input = { ...input, paymentId: byUid.id };
    }

    const payment = await this.prisma.read.payment.findUnique({ where: { id: input.paymentId } });
    if (!payment) {
      this.logger.warn(`Webhook de pago sin match (paymentId=${input.paymentId}); no-op`);
      return { applied: false, status: 'NO_MATCH' };
    }

    switch (input.status) {
      case 'CONFIRMED': {
        if (payment.status === 'CAPTURED') return { applied: false, status: 'CAPTURED' }; // idempotente
        await this.captureSuccess(payment, input.externalUid, payment.retries || 1);
        return { applied: true, status: 'CAPTURED' };
      }
      case 'DECLINED': {
        if (payment.status === 'CAPTURED' || payment.status === 'REFUNDED')
          return { applied: false, status: payment.status };
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
        if (payment.status === 'CAPTURED' || payment.status === 'REFUNDED')
          return { applied: false, status: payment.status };
        if (payment.status === 'FAILED') return { applied: false, status: 'FAILED' };
        await this.markFailed(payment, 'expired');
        return { applied: true, status: 'FAILED' };
      }
      default:
        return { applied: false, status: payment.status }; // PENDING → sin transición
    }
  }

  /** Marca un pago como FAILED (cobro externo expirado/cancelado). Emite payment.failed willRetry=false. */
  private async markFailed(payment: Payment, reason: string): Promise<Payment> {
    assertPaymentTransition(payment.status, 'FAILED');
    return this.prisma.write.$transaction(async (tx) => {
      const updated = await tx.payment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', failureReason: reason },
      });
      const envelope = createEnvelope({
        eventType: 'payment.failed',
        producer: 'payment-service',
        payload: { paymentId: updated.id, tripId: updated.tripId, reason, willRetry: false },
      });
      await enqueueOutbox(tx, envelope, updated.id);
      return updated;
    });
  }

  /**
   * Añade una propina a un viaje YA cobrado (BR-P04): el 100% va al conductor, fuera de comisión.
   * Idempotente por `dedupKey` (UNIQUE en TipAddition): reenviar la misma propina no la duplica.
   * Suma el monto a `payment.tipCents` y a `payment.amountCents` en la MISMA transacción que el
   * registro del incremento. Solo si existe el pago del viaje y está vivo (PENDING/CAPTURED).
   *
   * Efectivo vs digital: el modelo es uniforme — la propina se registra contra el pago del viaje en
   * ambos casos. La liquidación al conductor (payouts) ya agrega `tipCents` de los pagos CAPTURED,
   * así que un tip sobre un pago capturado entra en la liquidación de su período sin pasos extra.
   */
  async addTip(input: { tripId: string; tipCents: number; dedupKey: string }): Promise<Payment> {
    if (!Number.isInteger(input.tipCents) || input.tipCents <= 0) {
      throw new InvalidStateError('tipCents debe ser un entero de céntimos positivo');
    }

    // Idempotencia: si ya aplicamos esta propina, devolvemos el pago como está (sin re-sumar).
    const existingTip = await this.prisma.read.tipAddition.findUnique({
      where: { dedupKey: input.dedupKey },
    });
    if (existingTip) return this.getPayment(existingTip.paymentId);

    const payment = await this.prisma.read.payment.findFirst({
      where: { tripId: input.tripId, status: { in: ['PENDING', 'CAPTURED'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment)
      throw new NotFoundError('No hay un cobro vivo para este viaje al que añadir propina');
    assertCanAddTip(payment.status);

    try {
      return await this.prisma.write.$transaction(async (tx) => {
        await tx.tipAddition.create({
          data: {
            id: uuidv7(),
            paymentId: payment.id,
            tripId: payment.tripId,
            dedupKey: input.dedupKey,
            tipCents: input.tipCents,
          },
        });
        const updated = await tx.payment.update({
          where: { id: payment.id },
          data: {
            tipCents: { increment: input.tipCents },
            amountCents: { increment: input.tipCents },
          },
        });
        // Outbox (regla CLAUDE.md §3): la propina se publica en la MISMA transacción que su registro,
        // así el conductor se entera en vivo (driver-bff → push) sin que pueda quedar suma sin evento ni
        // evento sin suma. `driverId` ENRIQUECIDO para rutear sin join cross-servicio (puede ser null).
        const envelope = createEnvelope({
          eventType: 'payment.tip_added',
          producer: 'payment-service',
          payload: {
            paymentId: updated.id,
            tripId: updated.tripId,
            driverId: updated.driverId ?? undefined,
            tipCents: input.tipCents,
          },
        });
        await enqueueOutbox(tx, envelope, updated.id);
        return updated;
      });
    } catch (err) {
      // Carrera de doble-submit con la misma dedupKey: el UNIQUE garantiza una sola suma.
      if (isUniqueViolation(err, 'dedupKey')) {
        const dup = await this.prisma.read.tipAddition.findUnique({
          where: { dedupKey: input.dedupKey },
        });
        if (dup) return this.getPayment(dup.paymentId);
        throw new ConflictError('Propina duplicada para la misma dedupKey');
      }
      throw err;
    }
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
    const rows = await this.prisma.read.payment.findMany({
      where: { driverId, status: 'CAPTURED', capturedAt: { gte: from, lt: to } },
      select: { grossCents: true, commissionCents: true, tipCents: true },
    });
    let grossCents = 0;
    let commissionCents = 0;
    let tipCents = 0;
    for (const r of rows) {
      grossCents += r.grossCents;
      commissionCents += r.commissionCents;
      tipCents += r.tipCents;
    }
    return {
      grossCents,
      commissionCents,
      tipCents,
      netCents: grossCents - commissionCents + tipCents,
      tripCount: rows.length,
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
    const payment = await this.prisma.read.payment.findUnique({ where: { id: paymentId } });
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
    const confirmation = await this.prisma.write.cashConfirmation.upsert({
      where: { tripId },
      update: data,
      create: { id: uuidv7(), tripId, ...data },
    });

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
    await this.prisma.write.$transaction(async (tx) => {
      // CAS atómico: el estado va en el WHERE. Dos confirmaciones bilaterales concurrentes
      // (driver+passenger en la misma ventana de ms) leen ambas PENDING; solo la que matchea
      // PENDING→CAPTURED gana → un único payment.captured (sin push duplicado). El check en
      // confirmCash es TOCTOU contra el read stale; este CAS cierra la ventana.
      const { count } = await tx.payment.updateMany({
        where: { id: payment.id, status: 'PENDING' },
        data: { status: 'CAPTURED', capturedAt: new Date(), externalRef: `cash:${payment.tripId}` },
      });
      if (count === 0) return; // otra captura concurrente ya ganó: no re-emitir
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
      await enqueueOutbox(tx, envelope, payment.id);
    });
  }

  private async emitCashDiscrepancy(paymentId: string, tripId: string): Promise<void> {
    await this.prisma.write.$transaction(async (tx) => {
      const envelope = createEnvelope({
        eventType: 'payment.failed',
        producer: 'payment-service',
        payload: { paymentId, tripId, reason: 'CASH_DISCREPANCY', willRetry: false },
      });
      await enqueueOutbox(tx, envelope, paymentId);
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
  async refund(
    tripId: string,
    amountCents: number,
    reason: string,
    operator: AuthenticatedUser,
    idempotencyKey?: string,
    // Gesto EXPLÍCITO del operador "es un reembolso NUEVO, no un reintento": salta el backstop de ventana para
    // permitir un 2do parcial idéntico legítimo (el server no puede distinguirlo de un reintento sin esta señal).
    forceNew = false,
  ): Promise<{ refundId: string; paymentId: string; status: string }> {
    // Acepta un cobro CAPTURED o ya PARCIALMENTE reembolsado (para acumular más parciales, BR-P06).
    const payment = await this.prisma.read.payment.findFirst({
      where: { tripId, status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] } },
      orderBy: { capturedAt: 'desc' },
    });
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

    // Gate de monto alto (BR-P06): >S/30 requiere un rol con autoridad de finanzas. FINANCE es el rol money-OUT
    // canónico (decisión del dueño: refund = acción de finanzas) y satisface el gate; ADMIN/SUPERADMIN también.
    const needsL2 = amountCents > this.refundL2ThresholdCents;
    const roles = operator.roles ?? [];
    const hasL2 =
      roles.includes(AdminRole.FINANCE) ||
      roles.includes(AdminRole.ADMIN) ||
      roles.includes(AdminRole.SUPERADMIN);
    if (needsL2 && !hasL2) {
      throw new ForbiddenError('Un reembolso mayor a S/30 requiere un operador con autoridad de finanzas');
    }

    const newRefundedCents = payment.refundedCents + amountCents;
    const isFullyRefunded = newRefundedCents === payment.amountCents;
    const newStatus = isFullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    assertPaymentTransition(payment.status, newStatus);

    const claim: RefundClaim = {
      amountCents,
      reason,
      // Admin discrecional: el operador humano firma el pedido y la aprobación. Si el panel trae un
      // `Idempotency-Key`, lo usamos como barrera DURA de idempotencia (UNIQUE PARCIAL en Refund) para que un
      // doble-submit / reintento de red NO doble-reembolse — el refund PARCIAL no lo blinda la state machine
      // (el CAS solo impide exceder el saldo). Sin key (compat) ⇒ null: idempotencia = CAS optimista, como antes.
      requestedBy: operator.userId,
      approvedBy: operator.userId,
      dedupKey: idempotencyKey ? deriveAdminRefundDedupKey(idempotencyKey) : null,
      newStatus,
      newRefundedCents,
      isFullyRefunded,
      // Backstop server-side de ventana temporal sobre (paymentId, céntimos): SIEMPRE para el refund admin, salvo
      // que el operador haya marcado `forceNew` (2do parcial idéntico deliberado). Cierra el residual del nonce de
      // cliente (storage bloqueado, cross-tab, cross-device) que el `dedupKey` solo no puede.
      enforceWindowDedup: !forceNew,
    };

    try {
      return await this.executeRefundClaim(payment, claim);
    } catch (err) {
      // BACKSTOP DE VENTANA: ya hay un refund reciente del MISMO dinero (paymentId, céntimos) creado dentro de la
      // ventana → la operación es la MISMA (un reintento que llegó con otro key, o sin key) → devolvemos el
      // existente, NO doble-pagamos. Esto cierra el hueco que el `dedupKey` deja cuando el key del cliente diverge.
      if (err instanceof DuplicateRefundInWindowError) {
        this.logger.log(
          `Refund admin idempotente por VENTANA (mismo pago y monto, key divergente/ausente) trip=${tripId}; ` +
            `devuelvo el refund existente ${err.existing.refundId}`,
        );
        return err.existing;
      }
      // IDEMPOTENCIA: el MISMO `Idempotency-Key` ya creó un refund ACTIVO (UNIQUE parcial) → P2002. Sin key →
      // dedupKey null → este path no aplica (relanza). Leemos del PRIMARIO (`write`), no de la réplica: el
      // refund se acaba de commitear ahí y bajo lag la réplica devolvería null (read-after-write).
      if (idempotencyKey && isUniqueViolation(err, 'dedupKey')) {
        const existing = await this.prisma.write.refund.findFirst({
          where: { dedupKey: deriveAdminRefundDedupKey(idempotencyKey) },
          orderBy: { createdAt: 'desc' },
        });
        // El key identifica la IDENTIDAD DE DINERO de la operación: (pago, monto). Solo devolvemos el existente
        // si coincide en AMBOS — el motivo (texto libre) NO entra: un reintento con el motivo editado sigue
        // siendo la MISMA operación de dinero y debe dedupear, no fallar. Un key reusado para OTRO dinero
        // (distinto pago o monto) NO debe devolver un refund ajeno como éxito falso → conflicto explícito.
        if (existing && existing.paymentId === payment.id && existing.amountCents === amountCents) {
          this.logger.log(
            `Refund admin idempotente (mismo key, pago y monto) trip=${tripId}; devuelvo el refund existente`,
          );
          return {
            refundId: existing.id,
            paymentId: existing.paymentId,
            status: existing.status,
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
    const payment = await this.prisma.read.payment.findFirst({
      where: { tripId, status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] } },
      orderBy: { capturedAt: 'desc' },
    });
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
    };

    try {
      return await this.executeRefundClaim(payment, claim);
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

  /** Devolución LOCAL de un cobro CASH (la plata nunca pasó por el riel): COMPLETED + evento en una tx. */
  private async refundCashLocally(
    payment: Payment,
    claim: RefundClaim,
  ): Promise<{ refundId: string; paymentId: string; status: string }> {
    return this.prisma.write.$transaction(async (tx) => {
      await this.claimRefundReservationInTx(tx, payment, claim);
      // CASH: devolución FUERA del riel (soporte la entrega/transfiere) → COMPLETED en el acto.
      const refund = await tx.refund.create({
        data: {
          id: uuidv7(),
          paymentId: payment.id,
          amountCents: claim.amountCents,
          requestedBy: claim.requestedBy,
          approvedBy: claim.approvedBy,
          dedupKey: claim.dedupKey,
          status: RefundStatus.COMPLETED,
          reason: claim.reason,
        },
      });
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
    //    concurrentes sobre el mismo saldo y el Refund PENDING es el registro durable de la operación.
    const refund = await this.prisma.write.$transaction(async (tx) => {
      await this.claimRefundReservationInTx(tx, payment, claim);
      return tx.refund.create({
        data: {
          id: uuidv7(),
          paymentId: payment.id,
          amountCents: claim.amountCents,
          requestedBy: claim.requestedBy,
          approvedBy: claim.approvedBy,
          dedupKey: claim.dedupKey,
          status: RefundStatus.PENDING,
          reason: claim.reason,
        },
      });
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
      await this.prisma.write.refund.update({
        where: { id: refund.id },
        data: { externalRefundId: result.externalRefundId },
      });
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
    tx: Prisma.TransactionClient,
    payment: Payment,
    claim: RefundClaim,
  ): Promise<void> {
    // Backstop de idempotencia por VENTANA (solo refund admin discrecional): bajo un advisory lock por paymentId,
    // si ya hay un refund reciente del MISMO (paymentId, céntimos) → lanza DuplicateRefundInWindowError (refund()
    // la atrapa y devuelve el existente). El system-initiated NO lo lleva (claim.enforceWindowDedup undefined).
    if (claim.enforceWindowDedup) {
      await this.assertNoDuplicateAdminRefundInWindowTx(tx, payment.id, claim.amountCents);
    }
    const claimed = await tx.payment.updateMany({
      where: {
        id: payment.id,
        status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] },
        refundedCents: payment.refundedCents,
      },
      data: {
        status: claim.newStatus,
        refundedCents: claim.newRefundedCents,
        refundedAt: claim.isFullyRefunded ? new Date() : null,
      },
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
    tx: Prisma.TransactionClient,
    paymentId: string,
    amountCents: number,
  ): Promise<void> {
    // Advisory lock transaccional (se libera SOLO al cerrar la tx): hashtext(paymentId) → clave bigint estable.
    // `$executeRaw` (no `$queryRaw`): pg_advisory_xact_lock devuelve `void` y $queryRaw fallaría al deserializar
    // esa columna; $executeRaw ejecuta la sentencia sin deserializar el resultado.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${paymentId})::bigint)`;
    const since = new Date(Date.now() - ADMIN_REFUND_IDEMPOTENCY_WINDOW_MS);
    const recent = await tx.refund.findFirst({
      where: {
        paymentId,
        amountCents,
        status: { not: RefundStatus.REJECTED },
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
    });
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
    await this.prisma.write.refund.create({
      data: {
        id: uuidv7(),
        paymentId: payment.id,
        amountCents: claim.amountCents,
        requestedBy: claim.requestedBy,
        approvedBy: claim.approvedBy,
        status: RefundStatus.REJECTED,
        reason: claim.reason,
        dedupKey: claim.dedupKey,
        failureReason,
      },
    });
  }

  /**
   * payment.refunded por OUTBOX (misma tx, idempotencia financiera BR-P06). Se emite SOLO cuando la
   * plata efectivamente volvió (CASH local o confirmación del proveedor). `amountCents` = lo reembolsado
   * (no el bruto). `passengerId` enriquecido (persistido al cobrar) → push "te devolvimos S/X.XX".
   */
  private async enqueueRefundedEventInTx(
    tx: Prisma.TransactionClient,
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
    await enqueueOutbox(tx, envelope, payment.id);
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
    return this.prisma.write.$transaction(async (tx) => {
      const claimed = await tx.refund.updateMany({
        where: { id: refundId, status: RefundStatus.PENDING },
        data: {
          status: RefundStatus.COMPLETED,
          ...(externalRefundId ? { externalRefundId } : {}),
        },
      });
      if (claimed.count === 0) return false; // ya resuelto (redelivery) → idempotente, sin segundo evento.
      const refund = await tx.refund.findUniqueOrThrow({
        where: { id: refundId },
        include: { payment: true },
      });
      await this.enqueueRefundedEventInTx(tx, refund.payment, refund);
      return true;
    });
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
    const outcome = await this.prisma.write.$transaction(async (tx) => {
      const claimed = await tx.refund.updateMany({
        where: { id: refundId, status: RefundStatus.PENDING },
        data: { status: RefundStatus.REJECTED, failureReason },
      });
      if (claimed.count === 0) return { applied: false, systemInitiated: false }; // ya resuelto → idempotente.
      const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
      // Decremento ATÓMICO en la DB (no read-compute-write): toma el row-lock del Payment y devuelve la
      // fila con el saldo real ya restado, aun si otra reserva commiteó después de nuestro claim.
      const restored = await tx.payment.update({
        where: { id: refund.paymentId },
        data: { refundedCents: { decrement: refund.amountCents } },
      });
      // status/refundedAt derivados del saldo REAL post-decremento. Seguro dentro de la misma tx: el
      // row-lock tomado por el decremento bloquea cualquier escritura concurrente hasta nuestro commit.
      await tx.payment.update({
        where: { id: restored.id },
        data: {
          status: restored.refundedCents > 0 ? 'PARTIALLY_REFUNDED' : 'CAPTURED',
          refundedAt: null,
        },
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
    const refund = await this.prisma.read.refund.findFirst({
      where: { externalRefundId: input.externalRefundId },
    });
    if (!refund) {
      this.logger.warn(
        `Callback de reembolso sin match (uid=${input.externalRefundId}); respondemos no-2xx para que el proveedor reintente`,
      );
      throw new NotFoundError('Reverso no correlacionado todavía; reintente la entrega');
    }
    switch (input.status) {
      case 'CONFIRMED': {
        const applied = await this.completeRefund(refund.id, input.externalRefundId);
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
    const existing = await this.prisma.read.cancellationPenalty.findUnique({
      where: { tripId: input.tripId },
    });
    if (existing) {
      return { penaltyId: existing.id, status: existing.status };
    }

    const id = uuidv7();
    try {
      return await this.prisma.write.$transaction(async (tx) => {
        const penalty = await tx.cancellationPenalty.create({
          data: {
            id,
            tripId: input.tripId,
            passengerId: input.passengerId,
            driverId: input.driverId,
            penaltyCents: input.penaltyCents,
            driverCompensationCents,
            platformCents,
            status: 'PENDING',
            reason: input.reason,
          },
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
        await enqueueOutbox(tx, envelope, penalty.id);
        return { penaltyId: penalty.id, status: 'PENDING' };
      });
    } catch (err) {
      // Carrera: otra réplica creó la penalidad entre el findUnique y el create (P2002 sobre trip_id).
      if (isUniqueViolation(err, 'tripId')) {
        const raced = await this.prisma.read.cancellationPenalty.findUnique({
          where: { tripId: input.tripId },
        });
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

    const penalty = await this.prisma.read.cancellationPenalty.findUnique({
      where: { id: input.penaltyId },
    });
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
    const existing = await this.prisma.read.payment.findUnique({ where: { dedupKey } });
    if (existing) return existing;

    let payment: Payment;
    try {
      payment = await this.prisma.write.payment.create({
        data: {
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
        },
      });
    } catch (err) {
      // Carrera de doble-submit con la misma dedupKey: el UNIQUE garantiza una sola liquidación.
      if (isUniqueViolation(err, 'dedupKey')) {
        const dup = await this.prisma.read.payment.findUnique({ where: { dedupKey } });
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
    const confirmation = await this.prisma.write.cashConfirmation.upsert({
      where: { tripId: payment.tripId },
      update: { driverConfirmed: true },
      create: { id: uuidv7(), tripId: payment.tripId, driverConfirmed: true },
    });

    // El pasajero ya había confirmado (caso raro) → ambos true → captura inmediata.
    if (confirmation.passengerConfirmed) {
      await this.captureCash(payment);
      return this.getPayment(payment.id);
    }

    // Solo el conductor confirmó → PENDING esperando al pasajero. Emitimos cash_pending (push) por
    // OUTBOX (idempotencia financiera): aggregateId = paymentId, dedup natural del relay.
    await this.prisma.write.$transaction(async (tx) => {
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
      await enqueueOutbox(tx, envelope, payment.id);
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
    const result = await this.prisma.write.payment.updateMany({
      where: { passengerId: userId, payerRef: { not: null } },
      data: { payerRef: deletedPlaceholder(userId, 'payerRef') },
    });
    this.logger.log(
      `Derecho al olvido: payerRef anonimizado en ${result.count} pago(s) del usuario ${userId} ` +
        '(registros financieros conservados por obligación contable)',
    );
    return { paymentsAnonymized: result.count };
  }
}
