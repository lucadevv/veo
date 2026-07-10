/**
 * PaymentsRepository — ÚNICO punto de acceso Prisma del agregado de pagos (schema 'payment'). Espeja el patrón
 * de `ratings.repository.ts`: encapsula el read/write split (réplica vs primary), el patrón OUTBOX-EN-TRANSACCIÓN
 * (la mutación de dominio y el INSERT de su evento van en la MISMA tx Prisma, FOUNDATION §6) y expone métodos con
 * NOMBRES DE DOMINIO — nunca filtra `PrismaClient` crudo hacia el service.
 *
 * SEAM con PaymentsService: la LÓGICA DE DINERO (idempotencia por dedupKey, transiciones de la máquina de
 * estados, decisión CASH/gateway, compensaciones, backstops) vive ENTERA en el service. Este repo solo hace
 * acceso a datos y CRISTALIZA los INVARIANTES DE QUERY que NO deben poder cambiarse desde afuera:
 *   - los CAS optimistas llevan su predicado (`status`/`refundedCents`) HARDCODEADO en el WHERE del método
 *     (el service solo aporta el `data` con los valores computados) → nadie puede aflojar el lock por accidente;
 *   - la lectura read-after-write del refund por dedupKey corre en el PRIMARIO (`prisma.write`) como método
 *     DISTINTO (`findRefundByDedupKeyOnPrimary`) — jamás en la réplica (lag → null bajo carrera);
 *   - la compensación es un `decrement` ATÓMICO en la DB (nunca read-compute-write);
 *   - el advisory lock transaccional (`pg_advisory_xact_lock`) es un método propio.
 *
 * Como varios flujos interleavan lecturas y decisiones de dominio DENTRO de una misma transacción, el repo expone
 * `runInTransaction(work)` (dueño del `$transaction`) + métodos tx-scoped que reciben el `tx` opaco: el service
 * ORQUESTA la secuencia (lee → decide con dominio → escribe) sin tocar nunca `this.prisma` ni `tx.model.op`.
 */
import { Injectable } from '@nestjs/common';
import { enqueueOutbox as persistOutboxEvent } from '@veo/database';
import type { EventEnvelope } from '@veo/events';
import { uuidv7 } from '@veo/utils';
import type { PaymentMethod } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import {
  Prisma,
  RefundStatus,
  type CancellationPenalty,
  type CashConfirmation,
  type DriverCredit,
  type DriverDebt,
  type Payment,
  type Refund,
} from '../generated/prisma';

/** Handle de transacción opaco para el service: forwardea el `tx` a los métodos del repo, no lo dereferencia. */
export type PaymentTx = Prisma.TransactionClient;

/** Refund con su Payment incluido (lo que `completeRefund` relee para armar el `payment.refunded`). */
export type RefundWithPayment = Prisma.RefundGetPayload<{ include: { payment: true } }>;

/** Confirmación bilateral de efectivo (BR-P03): qué lado confirmó. El service arma la data; el repo hace el upsert. */
export interface CashConfirmationParty {
  driverConfirmed?: boolean;
  passengerConfirmed?: boolean;
}

@Injectable()
export class PaymentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Lecturas (réplica) ──────────────────────────────────────────────────────────────────────────────

  /** Lookup idempotente por dedupKey (charge, retry, tip, penalty settlement). Réplica. */
  findPaymentByDedupKey(dedupKey: string): Promise<Payment | null> {
    return this.prisma.read.payment.findUnique({ where: { dedupKey } });
  }

  /** Un pago por id (getPayment, retry/changeMethod re-read, webhook correlación). Réplica. */
  findPaymentById(id: string): Promise<Payment | null> {
    return this.prisma.read.payment.findUnique({ where: { id } });
  }

  /**
   * El cobro REEMBOLSABLE de un viaje (A1 · kind=FARE, CAPTURED o ya PARCIALMENTE reembolsado; el más
   * reciente). Único punto que define "el pago que se reembolsaría". Réplica.
   */
  findRefundablePaymentByTrip(tripId: string): Promise<Payment | null> {
    return this.prisma.read.payment.findFirst({
      where: { tripId, kind: 'FARE', status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] } },
      orderBy: { capturedAt: 'desc' },
    });
  }

  /** Cobros en DEBT del pasajero (gate de deuda). Réplica. */
  findPassengerDebtPayments(
    passengerId: string,
  ): Promise<Pick<Payment, 'id' | 'tripId' | 'amountCents' | 'failureReason' | 'createdAt'>[]> {
    return this.prisma.read.payment.findMany({
      where: { passengerId, kind: 'FARE', status: 'DEBT' },
      select: { id: true, tripId: true, amountCents: true, failureReason: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Cobros PENDING del pasajero (candidatos a "pago por completar"; el filtro de checkout vivo lo hace el service). Réplica. */
  findPassengerPendingPayments(passengerId: string): Promise<
    Pick<
      Payment,
      | 'id'
      | 'tripId'
      | 'amountCents'
      | 'createdAt'
      | 'externalUid'
      | 'checkoutUrl'
      | 'deepLink'
      | 'qrCode'
      | 'cip'
    >[]
  > {
    return this.prisma.read.payment.findMany({
      where: { passengerId, kind: 'FARE', status: 'PENDING' },
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
  }

  /** Penalidades de cancelación PENDING del pasajero (bloquean el gate igual que la deuda). Réplica. */
  findPassengerPendingPenalties(
    passengerId: string,
  ): Promise<Pick<CancellationPenalty, 'id' | 'tripId' | 'penaltyCents' | 'reason' | 'createdAt'>[]> {
    return this.prisma.read.cancellationPenalty.findMany({
      where: { passengerId, status: 'PENDING' },
      select: { id: true, tripId: true, penaltyCents: true, reason: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Correlación defensiva de un webhook sin `order`: por externalUid. Réplica. */
  findPaymentByExternalUid(externalUid: string): Promise<Payment | null> {
    return this.prisma.read.payment.findFirst({ where: { externalUid } });
  }

  /** La TARIFA viva de un viaje (kind=FARE, PENDING|CAPTURED, la más reciente) — base de una propina. Réplica. */
  findLiveFareByTrip(tripId: string): Promise<Payment | null> {
    return this.prisma.read.payment.findFirst({
      where: { tripId, kind: 'FARE', status: { in: ['PENDING', 'CAPTURED'] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Cobros liquidados de un conductor en una ventana (earnings, BR-P05). Réplica. */
  findDriverCapturedPayments(
    driverId: string,
    from: Date,
    to: Date,
  ): Promise<Pick<Payment, 'grossCents' | 'commissionCents' | 'tipCents' | 'kind'>[]> {
    return this.prisma.read.payment.findMany({
      where: {
        driverId,
        status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] },
        capturedAt: { gte: from, lt: to },
      },
      select: { grossCents: true, commissionCents: true, tipCents: true, kind: true },
    });
  }

  /** Propinas de un viaje a reembolsar/cancelar cuando el viaje se revierte (A1). Réplica. */
  findTripTips(tripId: string): Promise<Payment[]> {
    return this.prisma.read.payment.findMany({
      where: { tripId, kind: 'TIP', status: { in: ['PENDING', 'CAPTURED', 'PARTIALLY_REFUNDED'] } },
    });
  }

  /** Refund por el uid del reverso del proveedor (correlación del callback). Réplica. */
  findRefundByExternalRefundId(externalRefundId: string): Promise<Refund | null> {
    return this.prisma.read.refund.findFirst({ where: { externalRefundId } });
  }

  /** Penalidad por viaje (trip_id @unique). Réplica. */
  findPenaltyByTripId(tripId: string): Promise<CancellationPenalty | null> {
    return this.prisma.read.cancellationPenalty.findUnique({ where: { tripId } });
  }

  /** Penalidad por id (settle: ownership + estado). Réplica. */
  findPenaltyById(id: string): Promise<CancellationPenalty | null> {
    return this.prisma.read.cancellationPenalty.findUnique({ where: { id } });
  }

  // ── Escrituras no transaccionales (primary) ─────────────────────────────────────────────────────────

  /** Crea un Payment (cobro, tip-Payment, liquidación de penalidad). El service arma el `data` con la dedupKey. */
  createPayment(data: Prisma.PaymentUncheckedCreateInput): Promise<Payment> {
    return this.prisma.write.payment.create({ data });
  }

  /** Persiste el checkout del agregador (urlPay/qr/deepLink/cip/uid) sobre un Payment PENDING. */
  persistAggregatorCheckout(
    paymentId: string,
    data: Prisma.PaymentUncheckedUpdateInput,
  ): Promise<Payment> {
    return this.prisma.write.payment.update({ where: { id: paymentId }, data });
  }

  /** Marca FAILED (terminal) una PROPINA que declinó/expiró — update PLANO, sin emitir `payment.failed`. */
  markTipFailed(
    paymentId: string,
    data: Prisma.PaymentUncheckedUpdateInput,
  ): Promise<Payment> {
    return this.prisma.write.payment.update({ where: { id: paymentId }, data });
  }

  /** Status-guard DEBT→PENDING para re-cobrar (retryCharge). CAS: solo un llamador concurrente gana. */
  claimDebtForRetry(id: string): Promise<{ count: number }> {
    return this.prisma.write.payment.updateMany({
      where: { id, status: 'DEBT' },
      data: { status: 'PENDING', failureReason: null },
    });
  }

  /**
   * Status-guard del cambio de método (changeMethod): setea el método nuevo, LIMPIA el checkout viejo y
   * normaliza a PENDING, SOLO si sigue PENDING|DEBT. CAS: solo un llamador concurrente gana.
   */
  claimForMethodChange(id: string, method: PaymentMethod): Promise<{ count: number }> {
    return this.prisma.write.payment.updateMany({
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
  }

  /** Cancela en batch las propinas PENDING de un viaje revertido (CAS por-fila `status=PENDING`). */
  cancelPendingTips(ids: string[], failureReason: string): Promise<{ count: number }> {
    return this.prisma.write.payment.updateMany({
      where: { id: { in: ids }, status: 'PENDING' },
      data: { status: 'FAILED', failureReason },
    });
  }

  /** Derecho al olvido: anonimiza el `payerRef` de los pagos del usuario (registros financieros conservados). */
  anonymizePayerRef(userId: string, placeholder: string): Promise<{ count: number }> {
    return this.prisma.write.payment.updateMany({
      where: { passengerId: userId, payerRef: { not: null } },
      data: { payerRef: placeholder },
    });
  }

  /** Upsert de la confirmación bilateral de efectivo por viaje (idempotente por tripId @unique). */
  upsertCashConfirmation(
    tripId: string,
    party: CashConfirmationParty,
  ): Promise<CashConfirmation> {
    return this.prisma.write.cashConfirmation.upsert({
      where: { tripId },
      update: party,
      create: { id: uuidv7(), tripId, ...party },
    });
  }

  /**
   * Read-after-write del refund por dedupKey en el PRIMARIO (§4 · path P2002 de idempotencia admin): el refund
   * se ACABA de commitear en el primary; bajo lag la réplica devolvería null. NUNCA usar la réplica acá.
   */
  findRefundByDedupKeyOnPrimary(dedupKey: string): Promise<Refund | null> {
    return this.prisma.write.refund.findFirst({
      where: { dedupKey },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Persiste el uid del reverso del proveedor apenas llega (única clave de correlación del callback). */
  async setRefundExternalId(refundId: string, externalRefundId: string): Promise<void> {
    await this.prisma.write.refund.update({
      where: { id: refundId },
      data: { externalRefundId },
    });
  }

  /** Marcador DURABLE de un refund IRRECUPERABLE (Refund REJECTED de marca, fuera de transacción). */
  createRefund(data: Prisma.RefundUncheckedCreateInput): Promise<Refund> {
    return this.prisma.write.refund.create({ data });
  }

  // ── Transacciones (primary) ─────────────────────────────────────────────────────────────────────────

  /**
   * Dueño del `$transaction` (write). El service pasa `work`, que ORQUESTA lecturas/escrituras tx-scoped del
   * repo interleavadas con su lógica de dominio. Todo lo que corre en `work` es una única unidad ACID
   * (outbox-en-transacción).
   */
  runInTransaction<T>(work: (tx: PaymentTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(work);
  }

  /** Persiste un evento en el outbox DENTRO de la tx (FOUNDATION §6). El service arma el envelope. */
  async enqueueOutbox(
    tx: PaymentTx,
    envelope: EventEnvelope<unknown>,
    aggregateId: string,
  ): Promise<void> {
    await persistOutboxEvent(tx, envelope, aggregateId);
  }

  // captureSuccess ------------------------------------------------------------------------------------

  /**
   * CAS de captura: PENDING|DEBT|FAILED → CAPTURED (el estado va en el WHERE). El predicado es el INVARIANTE
   * (una sola captura gana; el perdedor ve count=0). El `data` (externalRef/retries/capturedAt/pspFee/net) lo
   * computa el service.
   */
  casCapturePayment(
    tx: PaymentTx,
    paymentId: string,
    data: Prisma.PaymentUncheckedUpdateManyInput,
  ): Promise<{ count: number }> {
    return tx.payment.updateMany({
      where: { id: paymentId, status: { in: ['PENDING', 'DEBT', 'FAILED'] } },
      data,
    });
  }

  /** Relee el Payment dentro de la tx (updateMany no devuelve la fila). */
  findPaymentByIdInTx(tx: PaymentTx, id: string): Promise<Payment> {
    return tx.payment.findUniqueOrThrow({ where: { id } });
  }

  // collectPenaltyInTx --------------------------------------------------------------------------------

  /** CAS de colecta de penalidad: PENDING → COLLECTED (idempotente; el perdedor/redelivery ve count=0). */
  casCollectPenalty(tx: PaymentTx, penaltyId: string): Promise<{ count: number }> {
    return tx.cancellationPenalty.updateMany({
      where: { id: penaltyId, status: 'PENDING' },
      data: { status: 'COLLECTED', collectedAt: new Date() },
    });
  }

  /** Relee la penalidad dentro de la tx (para armar el evento tras el CAS). */
  findPenaltyByIdInTx(tx: PaymentTx, penaltyId: string): Promise<CancellationPenalty | null> {
    return tx.cancellationPenalty.findUnique({ where: { id: penaltyId } });
  }

  // markDebt (rama DEBT) ------------------------------------------------------------------------------

  /** Marca DEBT un cobro (rama no-TIP), dentro de la tx que emite `payment.failed`. */
  markPaymentDebtInTx(
    tx: PaymentTx,
    id: string,
    data: Prisma.PaymentUncheckedUpdateInput,
  ): Promise<Payment> {
    return tx.payment.update({ where: { id }, data });
  }

  // captureCash ---------------------------------------------------------------------------------------

  /** CAS de captura de efectivo: PENDING → CAPTURED (cierra la ventana TOCTOU de la doble confirmación). */
  casCaptureCash(
    tx: PaymentTx,
    paymentId: string,
    data: Prisma.PaymentUncheckedUpdateManyInput,
  ): Promise<{ count: number }> {
    return tx.payment.updateMany({
      where: { id: paymentId, status: 'PENDING' },
      data,
    });
  }

  /** Acumula la deuda CASH de comisión del conductor DENTRO de la tx de captura (atomicidad captura ⇔ deuda). */
  createDriverDebtInTx(
    tx: PaymentTx,
    data: Prisma.DriverDebtUncheckedCreateInput,
  ): Promise<DriverDebt> {
    return tx.driverDebt.create({ data });
  }

  // reverseCashDebtInTx -------------------------------------------------------------------------------

  /** Deuda de comisión CASH asociada a un cobro (por paymentId @unique). */
  findDriverDebtByPaymentInTx(tx: PaymentTx, paymentId: string): Promise<DriverDebt | null> {
    return tx.driverDebt.findUnique({ where: { paymentId } });
  }

  /** Actualiza una deuda de conductor dentro de la tx (reducir / REVERSED / SETTLED→REVERSED). */
  updateDriverDebtInTx(
    tx: PaymentTx,
    id: string,
    data: Prisma.DriverDebtUncheckedUpdateInput,
  ): Promise<DriverDebt> {
    return tx.driverDebt.update({ where: { id }, data });
  }

  /** Acredita al conductor lo reversado cuando la deuda ya se neteó (SETTLED). Idempotente por sourcePaymentId. */
  createDriverCreditInTx(
    tx: PaymentTx,
    data: Prisma.DriverCreditUncheckedCreateInput,
  ): Promise<DriverCredit> {
    return tx.driverCredit.create({ data });
  }

  // refund reservation / creación in-tx ---------------------------------------------------------------

  /** Crea el Refund (PENDING o COMPLETED) DENTRO de la tx de la reserva. */
  createRefundInTx(tx: PaymentTx, data: Prisma.RefundUncheckedCreateInput): Promise<Refund> {
    return tx.refund.create({ data });
  }

  /**
   * CAS-RESERVA del reembolso (optimistic lock, idempotencia financiera #3): reclama el cobro SOLO si sigue
   * reembolsable (CAPTURED|PARTIALLY_REFUNDED) Y `refundedCents` no cambió desde el read. El predicado es el
   * INVARIANTE (cierra la carrera de refunds parciales/totales concurrentes); count=0 ⇒ CAS miss.
   */
  casClaimRefundReservation(
    tx: PaymentTx,
    paymentId: string,
    expectedRefundedCents: number,
    data: Prisma.PaymentUncheckedUpdateManyInput,
  ): Promise<{ count: number }> {
    return tx.payment.updateMany({
      where: {
        id: paymentId,
        status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] },
        refundedCents: expectedRefundedCents,
      },
      data,
    });
  }

  // assertNoDuplicateAdminRefundInWindowTx ------------------------------------------------------------

  /** Advisory lock TRANSACCIONAL por paymentId (serializa refunds concurrentes del mismo pago). */
  async acquirePaymentAdvisoryLock(tx: PaymentTx, paymentId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${paymentId})::bigint)`;
  }

  /** Refund NO-RECHAZADO del MISMO (paymentId, céntimos) creado dentro de la ventana (backstop temporal). */
  findRecentRefundInWindowInTx(
    tx: PaymentTx,
    paymentId: string,
    amountCents: number,
    since: Date,
  ): Promise<Refund | null> {
    return tx.refund.findFirst({
      where: {
        paymentId,
        amountCents,
        status: { not: RefundStatus.REJECTED },
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // completeRefund ------------------------------------------------------------------------------------

  /** CAS de completar refund: PENDING → COMPLETED (idempotente; una redelivery ve count=0). */
  casCompleteRefund(
    tx: PaymentTx,
    refundId: string,
    data: Prisma.RefundUncheckedUpdateManyInput,
  ): Promise<{ count: number }> {
    return tx.refund.updateMany({
      where: { id: refundId, status: RefundStatus.PENDING },
      data,
    });
  }

  /** Relee el Refund + su Payment dentro de la tx (para armar `payment.refunded`). */
  findRefundWithPaymentInTx(tx: PaymentTx, refundId: string): Promise<RefundWithPayment> {
    return tx.refund.findUniqueOrThrow({ where: { id: refundId }, include: { payment: true } });
  }

  // rejectRefundAndCompensate -------------------------------------------------------------------------

  /** CAS de rechazo de refund: PENDING → REJECTED (único punto; idempotente por CAS). */
  casRejectRefund(
    tx: PaymentTx,
    refundId: string,
    data: Prisma.RefundUncheckedUpdateManyInput,
  ): Promise<{ count: number }> {
    return tx.refund.updateMany({
      where: { id: refundId, status: RefundStatus.PENDING },
      data,
    });
  }

  /** Relee el Refund dentro de la tx (rechazo/compensación). */
  findRefundByIdInTx(tx: PaymentTx, refundId: string): Promise<Refund> {
    return tx.refund.findUniqueOrThrow({ where: { id: refundId } });
  }

  /**
   * COMPENSACIÓN ATÓMICA: `refundedCents -= amountCents` EN la DB (nunca read-compute-write). Toma el row-lock
   * del Payment y devuelve la fila con el saldo REAL ya restado, inmune a una reserva concurrente. Devuelve el
   * Payment para derivar el status restaurado.
   */
  decrementPaymentRefundedInTx(
    tx: PaymentTx,
    paymentId: string,
    amountCents: number,
  ): Promise<Payment> {
    return tx.payment.update({
      where: { id: paymentId },
      data: { refundedCents: { decrement: amountCents } },
    });
  }

  /** Restaura el status del Payment tras compensar la reserva (PARTIALLY_REFUNDED|CAPTURED derivado del saldo). */
  async restorePaymentAfterRejectInTx(
    tx: PaymentTx,
    paymentId: string,
    data: Prisma.PaymentUncheckedUpdateInput,
  ): Promise<void> {
    await tx.payment.update({ where: { id: paymentId }, data });
  }

  // recordCancellationPenalty -------------------------------------------------------------------------

  /** Crea la penalidad de cancelación DENTRO de la tx que emite `payment.cancellation_penalty_recorded`. */
  createPenaltyInTx(
    tx: PaymentTx,
    data: Prisma.CancellationPenaltyUncheckedCreateInput,
  ): Promise<CancellationPenalty> {
    return tx.cancellationPenalty.create({ data });
  }
}
