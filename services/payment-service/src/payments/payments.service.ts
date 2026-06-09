/**
 * PaymentsService — cobros idempotentes, comisión, reintentos→DEBT, efectivo bilateral y reembolsos.
 * BR-P01..P04, P06. El dinero SIEMPRE en céntimos PEN. Eventos vía OUTBOX (misma transacción).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createEnvelope } from '@veo/events';
import { enqueueOutbox } from '@veo/database';
import {
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
import {
  PAYMENT_GATEWAY,
  type PaymentGateway,
  type GatewayChargeResult,
  type WebhookStatus,
  YAPE_ONFILE_MAX_CENTS,
  YAPE_INSUFFICIENT_FUNDS_CODE,
  YAPE_INSUFFICIENT_FUNDS_REASON,
} from '../ports/gateway/payment-gateway.port';
import { AffiliationsService } from '../affiliations/affiliations.service';
import { PromotionsService } from '../promotions/promotions.service';
import { Prisma, type Payment } from '../generated/prisma';
import {
  assertCanAddTip,
  assertPaymentTransition,
  computeChargeAmounts,
  retryDelayMs,
} from './payment.policy';
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

export interface ChargeInput {
  tripId: string;
  grossCents: number;
  tipCents?: number;
  method: PaymentMethod;
  payerRef?: string;
  driverId?: string;
  dedupKey: string;
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

  private readonly paymentMode: 'live' | 'sandbox' | 'prontopaga';

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly affiliations: AffiliationsService,
    private readonly promotions: PromotionsService,
    config: ConfigService<Env, true>,
  ) {
    this.paymentMode = config.getOrThrow<'live' | 'sandbox' | 'prontopaga'>('VEO_PAYMENT_MODE');
    this.commissionRate = config.getOrThrow<number>('COMMISSION_RATE');
    this.maxRetries = config.getOrThrow<number>('PAYMENT_MAX_RETRIES');
    this.retryBaseMs = config.getOrThrow<number>('PAYMENT_RETRY_BASE_MS');
    this.defaultMethod = config.getOrThrow<PaymentMethod>('DEFAULT_PAYMENT_METHOD');
    this.refundWindowDays = config.getOrThrow<number>('REFUND_WINDOW_DAYS');
    this.refundL2ThresholdCents = config.getOrThrow<number>('REFUND_L2_THRESHOLD_CENTS');
    this.cancellationDriverShare = config.getOrThrow<number>('CANCELLATION_DRIVER_SHARE');
  }

  /**
   * Cobro idempotente (BR-P01/P04 + idempotencia). Segundo intento con la misma dedupKey
   * devuelve el MISMO pago sin recobrar. Yape/Plin se procesan contra el riel con reintentos→DEBT;
   * el efectivo queda PENDING hasta la confirmación bilateral (BR-P03).
   */
  async charge(input: ChargeInput): Promise<Payment> {
    // CARD/PAGOEFECTIVO solo se cobran vía el agregador (ProntoPaga). En sandbox/live, la tarjeta
    // (pre-auth) sigue siendo fase 4 y PagoEfectivo no aplica (no hay riel para ellos).
    if ((input.method === 'CARD' || input.method === 'PAGOEFECTIVO') && this.paymentMode !== 'prontopaga') {
      throw new InvalidStateError(
        `El cobro con ${input.method} requiere VEO_PAYMENT_MODE=prontopaga (no habilitado en modo ${this.paymentMode})`,
      );
    }

    const existing = await this.prisma.read.payment.findUnique({ where: { dedupKey: input.dedupKey } });
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

    const amounts = computeChargeAmounts(
      input.grossCents,
      input.tipCents ?? 0,
      this.commissionRate,
      discountCents,
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
          discountCents: amounts.discountCents,
          tipCents: amounts.tipCents,
          commissionCents: amounts.commissionCents,
          feeCents: amounts.feeCents,
          method: input.method,
          payerRef: input.payerRef ?? null,
          status: 'PENDING',
        },
      });
    } catch (err) {
      // Carrera de doble-submit con la misma dedupKey: el UNIQUE garantiza un solo pago.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const dup = await this.prisma.read.payment.findUnique({ where: { dedupKey: input.dedupKey } });
        if (dup) return dup;
        throw new ConflictError('Cobro duplicado para la misma dedupKey');
      }
      throw err;
    }

    if (input.method === 'CASH') {
      // El efectivo se captura con la confirmación bilateral (BR-P03), no contra el riel.
      return payment;
    }

    // Modo agregador (ProntoPaga): el cobro es ASÍNCRONO (un intento; el desenlace llega por webhook).
    if (this.paymentMode === 'prontopaga') {
      return this.processAggregatorCharge(payment, input);
    }

    // YAPE/PLIN sandbox/live → riel externo con reintentos y backoff (BR-P02).
    return this.processGatewayCharge(payment);
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
    const method = payment.method as Extract<PaymentMethod, 'YAPE' | 'PLIN' | 'CARD' | 'PAGOEFECTIVO'>;

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
    this.logger.log(`Cobro agregador PENDIENTE pago=${payment.id} uid=${result.externalRef ?? '-'} (espera webhook)`);
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
        this.logger.warn(`Intento ${attempt}/${this.maxRetries} falló (excepción) pago=${payment.id}: ${lastReason}`);
        continue;
      }

      if (result.status === 'CONFIRMED') {
        return this.captureSuccess(payment, result.externalRef ?? null, attempt);
      }
      // capability_unavailable: reintentar el MISMO método es inútil (no está habilitado en el comercio).
      // Cortamos el bucle YA y caemos a DEBT con la razón estructurada por-método.
      if (result.failureKind === 'capability_unavailable') {
        this.logger.warn(`Método ${method} no habilitado (capability) pago=${payment.id}: no se reintenta`);
        return this.markDebt(payment, methodUnavailableReason(method));
      }
      lastReason = result.reason ?? 'declined';
      this.logger.warn(`Intento ${attempt}/${this.maxRetries} declinado pago=${payment.id}: ${lastReason}`);
    }

    // Los 3 intentos fallaron → DEBT + payment.failed willRetry=false (bloqueo + alerta).
    return this.markDebt(payment, lastReason);
  }

  private async captureSuccess(payment: Payment, externalRef: string | null, attempts: number): Promise<Payment> {
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
   *  - prontopaga: re-corre el cobro por el agregador → nuevo checkout (urlPay/deepLink/qr/cip),
   *    el Payment queda PENDING y el poll/webhook existente lo cierra (CAPTURED o vuelve a DEBT).
   *  - sandbox/live (YAPE/PLIN): re-corre processGatewayCharge (reintentos→CAPTURED o DEBT).
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
      throw new InvalidStateError(`Solo un cobro en DEBT puede re-cobrarse (estado actual: ${payment.status})`);
    }
    // CASH no pasa por el riel (confirmación bilateral, BR-P03): no aplica re-cobro al gateway.
    if (payment.method === 'CASH') {
      throw new InvalidStateError('Un cobro en efectivo se salda por confirmación bilateral, no por re-cobro');
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

    // Re-cobro por el mismo camino que el cobro original, según el modo del gateway.
    if (this.paymentMode === 'prontopaga') {
      // El agregador es asíncrono: nuevo checkout; el poll/webhook existente cierra el Payment.
      return this.processAggregatorCharge(reclaimed, {
        tripId: reclaimed.tripId,
        grossCents: reclaimed.grossCents,
        method: reclaimed.method,
        dedupKey: reclaimed.dedupKey,
        userId: reclaimed.passengerId ?? undefined,
        payerRef: reclaimed.payerRef ?? undefined,
      });
    }
    // sandbox/live: reintentos contra el riel → CAPTURED o de vuelta a DEBT.
    return this.processGatewayCharge(reclaimed);
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
   *  - re-corre el cobro con el método nuevo por el MISMO camino que el cobro original según el modo:
   *    prontopaga → processAggregatorCharge (nuevo checkout PENDING); sandbox/live → processGatewayCharge.
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

    // Re-cobro con el método NUEVO por el mismo camino que el cobro original, según el modo del gateway.
    if (this.paymentMode === 'prontopaga') {
      // El agregador es asíncrono: nuevo checkout del método nuevo; el poll/webhook existente lo cierra.
      return this.processAggregatorCharge(reclaimed, {
        tripId: reclaimed.tripId,
        grossCents: reclaimed.grossCents,
        method: reclaimed.method,
        dedupKey: reclaimed.dedupKey,
        userId: reclaimed.passengerId ?? undefined,
        payerRef: reclaimed.payerRef ?? undefined,
      });
    }
    // sandbox/live (YAPE/PLIN): reintentos contra el riel → CAPTURED o de vuelta a DEBT.
    return this.processGatewayCharge(reclaimed);
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
      const byUid = await this.prisma.read.payment.findFirst({ where: { externalUid: input.externalUid } });
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
        if (payment.status === 'CAPTURED' || payment.status === 'REFUNDED') return { applied: false, status: payment.status };
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
        if (payment.status === 'CAPTURED' || payment.status === 'REFUNDED') return { applied: false, status: payment.status };
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
    if (!payment) throw new NotFoundError('No hay un cobro vivo para este viaje al que añadir propina');
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
        return tx.payment.update({
          where: { id: payment.id },
          data: {
            tipCents: { increment: input.tipCents },
            amountCents: { increment: input.tipCents },
          },
        });
      });
    } catch (err) {
      // Carrera de doble-submit con la misma dedupKey: el UNIQUE garantiza una sola suma.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const dup = await this.prisma.read.tipAddition.findUnique({ where: { dedupKey: input.dedupKey } });
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
  async earningsForDriver(driverId: string, from: Date, to: Date): Promise<DriverEarningsBreakdown> {
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
    party: 'driver' | 'passenger',
    confirmed: boolean,
  ): Promise<{ tripId: string; driverConfirmed: boolean; passengerConfirmed: boolean; status: string }> {
    const payment = await this.prisma.read.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundError('Pago no encontrado');
    if (payment.method !== 'CASH') throw new InvalidStateError('El pago no es en efectivo');
    const tripId = payment.tripId;

    const data =
      party === 'driver' ? { driverConfirmed: confirmed } : { passengerConfirmed: confirmed };
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

    if (confirmation.driverConfirmed && confirmation.passengerConfirmed && payment.status === 'PENDING') {
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
   * (>S/30 requiere L2). El operador autorizado aprueba en el acto → pago REFUNDED.
   */
  async refund(
    tripId: string,
    amountCents: number,
    reason: string,
    operator: AuthenticatedUser,
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
      throw new InvalidStateError(`Fuera de la ventana de reembolso (${this.refundWindowDays} días)`);
    }

    const needsL2 = amountCents > this.refundL2ThresholdCents;
    const roles = operator.roles ?? [];
    const hasL2 = roles.includes(AdminRole.SUPPORT_L2) || roles.includes(AdminRole.ADMIN) || roles.includes(AdminRole.SUPERADMIN);
    if (needsL2 && !hasL2) {
      throw new ForbiddenError('Un reembolso mayor a S/30 requiere aprobación de un operador L2');
    }

    const newRefundedCents = payment.refundedCents + amountCents;
    const isFullyRefunded = newRefundedCents === payment.amountCents;
    const newStatus = isFullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    assertPaymentTransition(payment.status, newStatus);
    return this.prisma.write.$transaction(async (tx) => {
      // CAS TRANSACCIONAL (BR-P06, idempotencia financiera #3): reclama el cobro SOLO si sigue reembolsable
      // Y `refundedCents` no cambió desde el read (optimistic lock). Cierra la carrera de refunds parciales/
      // totales concurrentes — bajo READ COMMITTED el 2do bloquea en el row-lock; al re-evaluar el WHERE
      // (refundedCents ya incrementado) obtiene count===0. Sin esto, dos refunds sumaban doble plata.
      const claimed = await tx.payment.updateMany({
        where: {
          id: payment.id,
          status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] },
          refundedCents: payment.refundedCents,
        },
        data: {
          status: newStatus,
          refundedCents: newRefundedCents,
          refundedAt: isFullyRefunded ? new Date() : null,
        },
      });
      if (claimed.count === 0) {
        throw new InvalidStateError(
          'El cobro cambió de estado o saldo por otra operación concurrente',
        );
      }
      const refund = await tx.refund.create({
        data: {
          id: uuidv7(),
          paymentId: payment.id,
          amountCents,
          requestedBy: operator.userId,
          approvedBy: operator.userId,
          status: 'COMPLETED',
          reason,
        },
      });
      // payment.refunded por OUTBOX (misma tx, idempotencia financiera BR-P06): el evento NO se emitía
      // y notification-service no podía avisar al pasajero. `amountCents` = lo reembolsado (no el bruto
      // original). `passengerId` enriquecido (persistido al cobrar) → push "te devolvimos S/X.XX".
      const envelope = createEnvelope({
        eventType: 'payment.refunded',
        producer: 'payment-service',
        payload: {
          paymentId: payment.id,
          tripId: payment.tripId,
          amountCents,
          reason,
          approvedBy: operator.userId,
          passengerId: payment.passengerId ?? undefined,
        },
      });
      await enqueueOutbox(tx, envelope, payment.id);
      return { refundId: refund.id, paymentId: payment.id, status: newStatus };
    });
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
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
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
      throw new InvalidStateError('Una penalidad de cancelación se paga por un medio digital, no en efectivo');
    }
    if ((input.method === 'CARD' || input.method === 'PAGOEFECTIVO') && this.paymentMode !== 'prontopaga') {
      throw new InvalidStateError(
        `El cobro con ${input.method} requiere VEO_PAYMENT_MODE=prontopaga (no habilitado en modo ${this.paymentMode})`,
      );
    }

    const penalty = await this.prisma.read.cancellationPenalty.findUnique({ where: { id: input.penaltyId } });
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
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const dup = await this.prisma.read.payment.findUnique({ where: { dedupKey } });
        if (dup) return dup;
        throw new ConflictError('Liquidación duplicada para la misma penalidad');
      }
      throw err;
    }

    // Cobro por el rail (espejo de charge): prontopaga es ASÍNCRONO (webhook captura → COLLECTED);
    // sandbox/live (YAPE/PLIN) corre el riel con reintentos y captura sync → COLLECTED en captureSuccess.
    if (this.paymentMode === 'prontopaga') {
      return this.processAggregatorCharge(payment, {
        tripId: penalty.tripId,
        grossCents: penalty.penaltyCents,
        method: input.method,
        payerRef: input.payerRef,
        dedupKey,
        userId: penalty.passengerId,
        client: input.client,
      });
    }
    return this.processGatewayCharge(payment);
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
}
