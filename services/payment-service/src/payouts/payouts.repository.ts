/**
 * PayoutsRepository — ÚNICO punto de acceso Prisma del agregado de liquidaciones (schema 'payment'). Espeja
 * `payments.repository.ts`: encapsula el read/write split (réplica vs primary), el patrón OUTBOX-EN-TRANSACCIÓN
 * (la mutación de dominio y el INSERT de su evento van en la MISMA tx Prisma, FOUNDATION §6) y expone métodos con
 * NOMBRES DE DOMINIO — nunca filtra `PrismaClient` crudo hacia el service.
 *
 * SEAM con PayoutsService: la LÓGICA DE DINERO (agregación semanal, NETTING de deuda CASH, step-up MFA, gate del
 * riel money-OUT, transiciones de la máquina de estados del payout, resiliencia por-item) vive ENTERA en el
 * service. Este repo solo hace acceso a datos y CRISTALIZA los INVARIANTES DE QUERY que NO deben poder cambiarse
 * desde afuera:
 *   - los CAS optimistas llevan su predicado (`status` de origen / `amountCents` esperado / `paidAt:null`)
 *     HARDCODEADO en el WHERE del método (el service solo aporta valores computados como el `dedupKey` o el
 *     nuevo monto) → nadie puede aflojar el lock por accidente;
 *   - el NETTING de la deuda CASH corre DENTRO de `runInTransaction` (unit-of-work): settle-deuda ⇔ payout es
 *     una sola unidad ACID; los CAS por `status=PENDING` + `amountCents` cierran la carrera con un refund
 *     concurrente (lost-update);
 *   - el `payout.processing` / `payout.processed` / `payout.failed` se emiten al outbox DENTRO de la misma tx
 *     que su CAS de estado (atomicidad estado↔evento, CLAUDE §3).
 *
 * Como el netting y las confirmaciones interleavan lecturas y decisiones de dominio DENTRO de una misma
 * transacción, el repo expone `runInTransaction(work)` (dueño del `$transaction`) + métodos tx-scoped que reciben
 * el `tx` opaco: el service ORQUESTA la secuencia sin tocar nunca `this.prisma` ni `tx.model.op`.
 */
import { Injectable } from '@nestjs/common';
import { enqueueOutbox as persistOutboxEvent } from '@veo/database';
import type { EventEnvelope } from '@veo/events';
import { PrismaService } from '../infra/prisma.service';
import { NON_CASH_METHODS } from '../payments/payment.policy';
import {
  Prisma,
  PayoutStatus,
  DriverCreditStatus,
  DriverDebtStatus,
  type Payout,
  type DriverCredit,
  type DriverDebt,
  type Payment,
} from '../generated/prisma';

/** Handle de transacción opaco para el service: forwardea el `tx` a los métodos del repo, no lo dereferencia. */
export type PayoutTx = Prisma.TransactionClient;

/** Suma de céntimos por conductor (groupBy) — el `_sum` nullable lo resuelve el service (`?? 0`). */
export interface DriverCentsSum {
  driverId: string;
  _sum: { amountCents: number | null };
}

/** Fila del groupBy de payouts por estado (KPIs del panel FINANCE). */
export interface PayoutStatusGroup {
  status: PayoutStatus;
  _count: { _all: number };
  _sum: { amountCents: number | null };
}

@Injectable()
export class PayoutsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Lecturas (réplica) ──────────────────────────────────────────────────────────────────────────────

  /** Suma la deuda CASH cobrada por el conductor en el período (cobros liquidados no-cash). Réplica.
   *  Cristaliza el filtro POSITIVO por método (índice [method,status,capturedAt]) + estado liquidado. */
  findCapturedNonCashPayments(
    from: Date,
    to: Date,
  ): Promise<Pick<Payment, 'driverId' | 'grossCents' | 'commissionCents' | 'tipCents'>[]> {
    return this.prisma.read.payment.findMany({
      where: {
        method: { in: [...NON_CASH_METHODS] },
        status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] },
        driverId: { not: null },
        capturedAt: { gte: from, lt: to },
      },
      select: { driverId: true, grossCents: true, commissionCents: true, tipCents: true },
    });
  }

  /** Penalidades de cancelación SALDADAS (COLLECTED) en el período — compensación al conductor que esperó. Réplica. */
  findCollectedPenalties(
    from: Date,
    to: Date,
  ): Promise<{ driverId: string | null; driverCompensationCents: number }[]> {
    return this.prisma.read.cancellationPenalty.findMany({
      where: { status: 'COLLECTED', driverId: { not: null }, collectedAt: { gte: from, lt: to } },
      select: { driverId: true, driverCompensationCents: true },
    });
  }

  /** Bonos de incentivo COMPLETADOS y aún NO pagados ni ligados (paidAt:null, paidInPayoutId:null). Réplica.
   *  Back-pay por arrastre: `completedAt < end` (no acotado al período) — el guard `paidAt:null` mantiene la idempotencia. */
  findUnpaidCompletedIncentives(
    end: Date,
  ): Promise<{ id: string; driverId: string; rewardGrantedCents: number }[]> {
    return this.prisma.read.incentiveProgress.findMany({
      where: { paidAt: null, paidInPayoutId: null, completedAt: { not: null, lt: end } },
      select: { id: true, driverId: true, rewardGrantedCents: true },
    });
  }

  /** Créditos PENDING del conductor agregados (credit-back de comisión CASH revertida). Réplica. */
  async sumPendingCreditsByDriver(): Promise<DriverCentsSum[]> {
    const rows = await this.prisma.read.driverCredit.groupBy({
      by: ['driverId'],
      where: { status: 'PENDING' },
      _sum: { amountCents: true },
    });
    return rows;
  }

  /** Deuda CASH PENDIENTE de los conductores dados, agregada (para netear contra su crédito). Réplica. */
  async sumPendingDebtsByDriver(driverIds: string[]): Promise<DriverCentsSum[]> {
    const rows = await this.prisma.read.driverDebt.groupBy({
      by: ['driverId'],
      where: { status: 'PENDING', driverId: { in: driverIds } },
      _sum: { amountCents: true },
    });
    return rows;
  }

  /** Los driverIds YA liquidados en el período (idempotencia SIN N+1: una query, no un findUnique por driver). Réplica. */
  async findPaidDriverIdsForPeriod(start: Date, end: Date, driverIds: string[]): Promise<string[]> {
    const rows = await this.prisma.read.payout.findMany({
      where: { periodStart: start, periodEnd: end, driverId: { in: driverIds } },
      select: { driverId: true },
    });
    return rows.map((p) => p.driverId);
  }

  /** Payouts PENDING del período (candidatos al disparo del operador), oldest-first por id. Réplica. */
  findPendingPayoutsForPeriod(start: Date, end: Date): Promise<Payout[]> {
    return this.prisma.read.payout.findMany({
      where: { periodStart: start, periodEnd: end, status: PayoutStatus.PENDING },
      orderBy: { id: 'asc' },
    });
  }

  /** Payouts HELD de un conductor (camino de vuelta de driver.flagged), oldest-first por período. Réplica. */
  findHeldPayoutsByDriver(driverId: string): Promise<Payout[]> {
    return this.prisma.read.payout.findMany({
      where: { driverId, status: PayoutStatus.HELD },
      orderBy: { periodStart: 'asc' },
    });
  }

  /** Un payout por id (retry gate, confirmación, detalle). Réplica. */
  findPayoutById(id: string): Promise<Payout | null> {
    return this.prisma.read.payout.findUnique({ where: { id } });
  }

  /** Payouts de un conductor (listado por-dueño), más recientes primero. Réplica. */
  findPayoutsByDriver(driverId: string): Promise<Payout[]> {
    return this.prisma.read.payout.findMany({
      where: { driverId },
      orderBy: { periodStart: 'desc' },
    });
  }

  /** Página admin/finance de payouts (cursor por id desc, filtrable por estado). `take` = limit+1 (el service
   *  detecta hasMore). El WHERE (status + cursor `id < cursor`) se arma acá; el service no toca `Prisma.*`. Réplica. */
  findPayoutsPage(opts: { status?: PayoutStatus; cursor?: string; take: number }): Promise<Payout[]> {
    const where: Prisma.PayoutWhereInput = {};
    if (opts.status) where.status = opts.status;
    if (opts.cursor) where.id = { lt: opts.cursor };
    return this.prisma.read.payout.findMany({
      where,
      orderBy: { id: 'desc' },
      take: opts.take,
    });
  }

  /** Suma de los credit-back APPLIED ligados a ESTE payout (componente del waterfall del netting). Réplica. */
  async sumAppliedCreditsForPayout(payoutId: string): Promise<number> {
    const agg = await this.prisma.read.driverCredit.aggregate({
      where: { appliedInPayoutId: payoutId, status: DriverCreditStatus.APPLIED },
      _sum: { amountCents: true },
    });
    return agg._sum.amountCents ?? 0;
  }

  /** Suma de las deudas CASH SETTLED ligadas a ESTE payout (componente del waterfall del netting). Réplica. */
  async sumSettledDebtsForPayout(payoutId: string): Promise<number> {
    const agg = await this.prisma.read.driverDebt.aggregate({
      where: { settledInPayoutId: payoutId, status: DriverDebtStatus.SETTLED },
      _sum: { amountCents: true },
    });
    return agg._sum.amountCents ?? 0;
  }

  /** KPIs por estado (UN solo groupBy: volumen total + conteos). Réplica. */
  async groupPayoutsByStatus(): Promise<PayoutStatusGroup[]> {
    const rows = await this.prisma.read.payout.groupBy({
      by: ['status'],
      _count: { _all: true },
      _sum: { amountCents: true },
    });
    return rows;
  }

  /** Suma de los BONOS de incentivo ligados a ESTE payout (paidInPayoutId · componente NETO del monto). Réplica.
   *  Mismo patrón acotado-por-FK que sumAppliedCreditsForPayout/sumSettledDebtsForPayout (no un scan por driver). */
  async sumBonusForPayout(payoutId: string): Promise<number> {
    const agg = await this.prisma.read.incentiveProgress.aggregate({
      where: { paidInPayoutId: payoutId },
      _sum: { rewardGrantedCents: true },
    });
    return agg._sum.rewardGrantedCents ?? 0;
  }

  /**
   * "Viajes incluidos" de un payout: los Payment del conductor capturados en el período. RECONSTRUCCIÓN — el
   * payout NO persiste sus líneas; se rearman con la MISMA condición POSITIVA que usa el run de liquidación
   * (`findCapturedNonCashPayments`): método NON-CASH + estado liquidado (CAPTURED/PARTIALLY_REFUNDED) + rango
   * `capturedAt`, acotado al conductor. Empuja el índice [driverId, status, capturedAt]. `take` capa la lista
   * (el conteo total va aparte). Réplica. */
  findDriverCapturedPaymentsForPeriod(
    driverId: string,
    from: Date,
    to: Date,
    take: number,
  ): Promise<Pick<Payment, 'tripId' | 'grossCents' | 'capturedAt' | 'method'>[]> {
    return this.prisma.read.payment.findMany({
      where: {
        driverId,
        method: { in: [...NON_CASH_METHODS] },
        status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] },
        capturedAt: { gte: from, lt: to },
      },
      select: { tripId: true, grossCents: true, capturedAt: true, method: true },
      orderBy: { capturedAt: 'desc' },
      take,
    });
  }

  /** Conteo TOTAL de los viajes reconstruidos del payout (para el "+N más" del panel). MISMA condición que
   *  findDriverCapturedPaymentsForPeriod, sin materializar filas. Réplica. */
  countDriverCapturedPaymentsForPeriod(driverId: string, from: Date, to: Date): Promise<number> {
    return this.prisma.read.payment.count({
      where: {
        driverId,
        method: { in: [...NON_CASH_METHODS] },
        status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] },
        capturedAt: { gte: from, lt: to },
      },
    });
  }

  /** TODAS las filas del filtro admin (sin paginar) para el export CSV. Filtrable por estado; orden id desc
   *  (uuidv7 ⇒ cronológico estable, mismo criterio que findPayoutsPage). Réplica. */
  findAllPayoutsForExport(status?: PayoutStatus): Promise<Payout[]> {
    const where: Prisma.PayoutWhereInput = {};
    if (status) where.status = status;
    return this.prisma.read.payout.findMany({ where, orderBy: { id: 'desc' } });
  }

  // ── Balance pendiente del conductor (riel driver · lecturas del período ABIERTO) ────────────────────

  /** Fin del ÚLTIMO período ya agregado en un Payout del conductor (cualquier estado: la fila existe ⇒ el
   *  período se agregó). Null si nunca tuvo payout → su período abierto arranca desde siempre. Réplica. */
  async findLatestPayoutPeriodEnd(driverId: string): Promise<Date | null> {
    const row = await this.prisma.read.payout.findFirst({
      where: { driverId },
      orderBy: { periodEnd: 'desc' },
      select: { periodEnd: true },
    });
    return row?.periodEnd ?? null;
  }

  /** Devengado DIGITAL del conductor desde `from` (o desde siempre si null): agrega gross/commission/tip de
   *  sus cobros NON-CASH liquidados (CAPTURED/PARTIALLY_REFUNDED) SIN materializar filas. MISMA condición
   *  positiva que el run de liquidación (findCapturedNonCashPayments), acotada al conductor y con borde
   *  inferior abierto — es "lo que el próximo run le va a agregar". Réplica. */
  async aggregateDriverCapturedNonCashSince(
    driverId: string,
    from: Date | null,
  ): Promise<{ grossCents: number; commissionCents: number; tipCents: number }> {
    const agg = await this.prisma.read.payment.aggregate({
      where: {
        driverId,
        method: { in: [...NON_CASH_METHODS] },
        status: { in: ['CAPTURED', 'PARTIALLY_REFUNDED'] },
        ...(from ? { capturedAt: { gte: from } } : {}),
      },
      _sum: { grossCents: true, commissionCents: true, tipCents: true },
    });
    return {
      grossCents: agg._sum.grossCents ?? 0,
      commissionCents: agg._sum.commissionCents ?? 0,
      tipCents: agg._sum.tipCents ?? 0,
    };
  }

  /** Deuda CASH PENDING total de UN conductor (comisión de viajes en efectivo cobrados en mano). Es lo que el
   *  netting del próximo run le va a descontar (applyDebtNetting lee estas MISMAS filas PENDING). Réplica. */
  async sumPendingDebtCentsForDriver(driverId: string): Promise<number> {
    const agg = await this.prisma.read.driverDebt.aggregate({
      where: { driverId, status: 'PENDING' },
      _sum: { amountCents: true },
    });
    return agg._sum.amountCents ?? 0;
  }

  /** Crédito PENDING total de UN conductor (credit-back de comisión CASH revertida — a su favor). Réplica. */
  async sumPendingCreditCentsForDriver(driverId: string): Promise<number> {
    const agg = await this.prisma.read.driverCredit.aggregate({
      where: { driverId, status: 'PENDING' },
      _sum: { amountCents: true },
    });
    return agg._sum.amountCents ?? 0;
  }

  // ── Escrituras no transaccionales (primary) ─────────────────────────────────────────────────────────

  /** BACKSTOP del gate de review en el DESEMBOLSO: retiene (→HELD) los PENDING flaggeados por id. CAS
   *  por-fila `status=PENDING` HARDCODEADO (idempotente, no toca PROCESSING/PROCESSED). */
  async holdPendingPayoutsByIds(ids: string[], heldReason: string): Promise<void> {
    await this.prisma.write.payout.updateMany({
      where: { id: { in: ids }, status: PayoutStatus.PENDING },
      data: { status: PayoutStatus.HELD, heldReason },
    });
  }

  /** RETRO-HOLD de driver.flagged: flippea a HELD los PENDING vigentes del conductor. CAS `status=PENDING`
   *  HARDCODEADO (transición válida PENDING→HELD, idempotente). */
  async holdPendingPayoutsByDriver(driverId: string, heldReason: string): Promise<void> {
    await this.prisma.write.payout.updateMany({
      where: { driverId, status: PayoutStatus.PENDING },
      data: { status: PayoutStatus.HELD, heldReason },
    });
  }

  /** Persiste el ref externo del riel apenas llega (correlaciona el webhook/poll de confirmación). Fuera de tx (I/O). */
  async persistPayoutExternalRef(payoutId: string, externalRef: string): Promise<void> {
    await this.prisma.write.payout.update({
      where: { id: payoutId },
      data: { externalRef },
    });
  }

  // ── Transacciones (primary · unit-of-work) ──────────────────────────────────────────────────────────

  /**
   * Dueño del `$transaction` (write). El service pasa `work`, que ORQUESTA lecturas/escrituras tx-scoped del
   * repo interleavadas con su lógica de dominio (netting, transiciones). Todo lo que corre en `work` es una
   * única unidad ACID (outbox-en-transacción).
   */
  runInTransaction<T>(work: (tx: PayoutTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(work);
  }

  /** Persiste un evento en el outbox DENTRO de la tx (FOUNDATION §6). El service arma el envelope. */
  async enqueueOutbox(
    tx: PayoutTx,
    envelope: EventEnvelope<unknown>,
    aggregateId: string,
  ): Promise<void> {
    await persistOutboxEvent(tx, envelope, aggregateId);
  }

  // applyDebtNetting (unit-of-work · A2 ADR-022 §P-A) -------------------------------------------------

  /** Créditos PENDING del conductor DENTRO de la tx (FIFO más viejos primero). */
  findPendingCreditsInTx(tx: PayoutTx, driverId: string): Promise<DriverCredit[]> {
    return tx.driverCredit.findMany({
      where: { driverId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Marca un crédito APPLIED ligado a este payout (idempotencia del run: se aplica una vez). Data hardcodeada. */
  async markCreditAppliedInTx(tx: PayoutTx, creditId: string, payoutId: string): Promise<void> {
    await tx.driverCredit.update({
      where: { id: creditId },
      data: { status: 'APPLIED', appliedInPayoutId: payoutId, appliedAt: new Date() },
    });
  }

  /** Deudas CASH PENDING del conductor DENTRO de la tx (FIFO más viejas primero). */
  findPendingDebtsInTx(tx: PayoutTx, driverId: string): Promise<DriverDebt[]> {
    return tx.driverDebt.findMany({
      where: { driverId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * CAS de netteo TOTAL de una deuda: PENDING → SETTLED ligada a este payout. El predicado `status=PENDING` +
   * `amountCents=expectedAmountCents` está HARDCODEADO en el WHERE — cierra el lost-update contra un refund
   * concurrente (reverseCashDebtInTx) que revirtió/redujo la deuda entre el findMany y este update (count=0 ⇒ la
   * saltamos). El service solo aporta el monto esperado + el payoutId.
   */
  settleDebtInTx(
    tx: PayoutTx,
    debtId: string,
    expectedAmountCents: number,
    payoutId: string,
  ): Promise<{ count: number }> {
    return tx.driverDebt.updateMany({
      where: { id: debtId, status: 'PENDING', amountCents: expectedAmountCents },
      data: { status: 'SETTLED', settledInPayoutId: payoutId, settledAt: new Date() },
    });
  }

  /**
   * CAS de netteo PARCIAL de la deuda del BORDE: reduce el monto (queda PENDING con el resto → carry-forward),
   * sin partir la fila (respeta UNIQUE(paymentId)). MISMO predicado `status=PENDING` + `amountCents` esperado
   * (cierra el lost-update). El service computa el `newAmountCents`.
   */
  reduceDebtInTx(
    tx: PayoutTx,
    debtId: string,
    expectedAmountCents: number,
    newAmountCents: number,
  ): Promise<{ count: number }> {
    return tx.driverDebt.updateMany({
      where: { id: debtId, status: 'PENDING', amountCents: expectedAmountCents },
      data: { amountCents: newAmountCents },
    });
  }

  /** Crea el Payout DENTRO de la tx del run (atómico con el netting). El service arma la data (neto, estado, held). */
  async createPayoutInTx(tx: PayoutTx, data: Prisma.PayoutUncheckedCreateInput): Promise<void> {
    await tx.payout.create({ data });
  }

  /**
   * Liga los bonos pendientes al Payout (paidInPayoutId) SIN marcar paidAt: el marcado se hace al confirmar el
   * desembolso. CAS `paidAt:null` + `paidInPayoutId:null` HARDCODEADO — no re-liga un bono ya pagado NI uno ya
   * ligado a otro payout (RC15 · ADR-022: defensa en profundidad contra el doble-pago del bono cross-period).
   */
  async linkIncentivesToPayoutInTx(
    tx: PayoutTx,
    incentiveIds: string[],
    payoutId: string,
  ): Promise<void> {
    await tx.incentiveProgress.updateMany({
      where: { id: { in: incentiveIds }, paidAt: null, paidInPayoutId: null },
      data: { paidInPayoutId: payoutId },
    });
  }

  // disburseOne (unit-of-work) ------------------------------------------------------------------------

  /**
   * CAS de reclamo del desembolso: estado-origen → PROCESSING + dedupKey. El predicado `status=fromStatus`
   * (el estado leído: PENDING|HELD|FAILED) va en el WHERE; el target PROCESSING está HARDCODEADO. Gana UNA
   * corrida: el doble-click ve count=0 y NO invoca el riel. El service aporta el `fromStatus` + la dedupKey.
   */
  casClaimPayoutProcessingInTx(
    tx: PayoutTx,
    payoutId: string,
    fromStatus: PayoutStatus,
    dedupKey: string,
  ): Promise<{ count: number }> {
    return tx.payout.updateMany({
      where: { id: payoutId, status: fromStatus },
      data: { status: PayoutStatus.PROCESSING, dedupKey },
    });
  }

  // applyPayoutDisbursementResult (unit-of-work) ------------------------------------------------------

  /** CAS de confirmación: PROCESSING → PROCESSED (+ processedAt). Predicado y data HARDCODEADOS (idempotente). */
  casMarkPayoutProcessedInTx(tx: PayoutTx, payoutId: string): Promise<{ count: number }> {
    return tx.payout.updateMany({
      where: { id: payoutId, status: PayoutStatus.PROCESSING },
      data: { status: PayoutStatus.PROCESSED, processedAt: new Date() },
    });
  }

  /** Marca paidAt de los bonos ligados a este payout (RECIÉN al confirmar). CAS `paidAt:null` HARDCODEADO. */
  async markIncentivesPaidInTx(tx: PayoutTx, payoutId: string): Promise<void> {
    await tx.incentiveProgress.updateMany({
      where: { paidInPayoutId: payoutId, paidAt: null },
      data: { paidAt: new Date() },
    });
  }

  /** CAS de rechazo: PROCESSING → FAILED (la plata NO salió). Predicado y data HARDCODEADOS (idempotente). */
  casMarkPayoutFailedInTx(tx: PayoutTx, payoutId: string): Promise<{ count: number }> {
    return tx.payout.updateMany({
      where: { id: payoutId, status: PayoutStatus.PROCESSING },
      data: { status: PayoutStatus.FAILED },
    });
  }
}
