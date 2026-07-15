/**
 * ReconciliationRepository — ÚNICO punto de acceso Prisma del módulo de conciliación (schema 'payment'):
 * lo comparten ReconciliationService (conciliación diaria + barridos de red de seguridad) y PaymentPollService
 * (poll fallback de cobros). Espeja `commission.repository.ts`: acceso SIMPLE de solo-lectura (más un único
 * INSERT del run de conciliación) — sin transacciones, sin CAS, sin outbox — con métodos de NOMBRE DE DOMINIO que
 * nunca filtran `PrismaClient` crudo hacia los services.
 *
 * CRISTALIZA los INVARIANTES DE QUERY de los barridos: los predicados de estado/método (`Refund PENDING`,
 * `Payment PENDING + CASH`, `Payment PENDING con externalUid`) van HARDCODEADOS en el WHERE; el service solo
 * aporta el umbral temporal computado y el tope de filas. La conciliación es SOLO-LECTURA sobre la réplica salvo
 * el registro del run (primary).
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import {
  Prisma,
  PaymentMethod,
  PaymentStatus,
  RefundStatus,
  type Payment,
  type Refund,
  type ReconciliationRun,
} from '../generated/prisma';

/** Detalle accionable de un Refund PENDING viejo (lo que el barrido loguea a ops). */
export type StaleRefundDetail = Pick<
  Refund,
  'id' | 'paymentId' | 'amountCents' | 'externalRefundId' | 'requestedBy' | 'createdAt'
>;

/** Detalle accionable de un cobro en efectivo PENDING viejo. */
export type StaleCashDetail = Pick<
  Payment,
  'id' | 'tripId' | 'driverId' | 'passengerId' | 'amountCents' | 'createdAt'
>;

/** Cobro PENDING candidato del poll fallback (con su uid del proveedor para consultar el estado). */
export type PollablePayment = Pick<Payment, 'id' | 'externalUid' | 'createdAt'>;

/** Total NETO esperado en el banco + conteo de cobros digitales CAPTURED del período (lado DB de la conciliación). */
export interface CapturedDigitalSettlement {
  dbTotalCents: number;
  dbCount: number;
}

@Injectable()
export class ReconciliationRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Barrido de Refunds PENDING viejos (réplica) ───────────────────────────────────────────────────

  /** Cuenta los Refunds PENDING más viejos que `threshold` (predicado PENDING HARDCODEADO). Réplica. */
  countStalePendingRefunds(threshold: Date): Promise<number> {
    return this.prisma.read.refund.count({
      where: { status: RefundStatus.PENDING, createdAt: { lt: threshold } },
    });
  }

  /** Detalle (acotado a `take`, oldest-first) de los Refunds PENDING más viejos que `threshold`. Réplica. */
  findStalePendingRefunds(threshold: Date, take: number): Promise<StaleRefundDetail[]> {
    return this.prisma.read.refund.findMany({
      where: { status: RefundStatus.PENDING, createdAt: { lt: threshold } },
      select: {
        id: true,
        paymentId: true,
        amountCents: true,
        externalRefundId: true,
        requestedBy: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
      take,
    });
  }

  // ── Barrido de efectivo PENDING viejo (réplica) ───────────────────────────────────────────────────

  /** Cuenta los cobros en EFECTIVO PENDING más viejos que `threshold` (predicado PENDING+CASH HARDCODEADO). Réplica. */
  countStaleCashPending(threshold: Date): Promise<number> {
    return this.prisma.read.payment.count({
      where: {
        status: PaymentStatus.PENDING,
        method: PaymentMethod.CASH,
        createdAt: { lt: threshold },
      },
    });
  }

  /** Detalle (acotado a `take`, oldest-first) de los cobros en efectivo PENDING más viejos que `threshold`. Réplica. */
  findStaleCashPending(threshold: Date, take: number): Promise<StaleCashDetail[]> {
    return this.prisma.read.payment.findMany({
      where: {
        status: PaymentStatus.PENDING,
        method: PaymentMethod.CASH,
        createdAt: { lt: threshold },
      },
      select: {
        id: true,
        tripId: true,
        driverId: true,
        passengerId: true,
        amountCents: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
      take,
    });
  }

  // ── Conciliación diaria ───────────────────────────────────────────────────────────────────────────

  /**
   * Lado DB de la conciliación: SUMA el NETO esperado en el banco (net_settled ?? amount por fila, P-B ADR-022) +
   * conteo de cobros CAPTURED por rieles externos (Yape/Plin) en [start, end). Raw SQL por el COALESCE POR-FILA
   * que un aggregate de Prisma no expresa; usa el índice [method, status, capturedAt]. Réplica.
   */
  async sumCapturedDigitalSettlement(start: Date, end: Date): Promise<CapturedDigitalSettlement> {
    const [row] = await this.prisma.read.$queryRaw<{ db_total: bigint; db_count: bigint }[]>(
      Prisma.sql`
        SELECT COALESCE(SUM(COALESCE("net_settled_cents", "amount_cents")), 0)::bigint AS db_total,
               COUNT(*)::bigint                                                        AS db_count
        FROM "payment"."payments"
        WHERE "status" = ${PaymentStatus.CAPTURED}::"payment"."PaymentStatus"
          AND "method" IN (
                ${PaymentMethod.YAPE}::"payment"."PaymentMethod",
                ${PaymentMethod.PLIN}::"payment"."PaymentMethod"
              )
          AND "captured_at" >= ${start} AND "captured_at" < ${end}
      `,
    );
    return { dbTotalCents: Number(row?.db_total ?? 0), dbCount: Number(row?.db_count ?? 0) };
  }

  /** Registra la corrida de conciliación (BR-P07). El service arma la data (discrepancia, alerted, details). Primary. */
  async createReconciliationRun(
    data: Prisma.ReconciliationRunUncheckedCreateInput,
  ): Promise<void> {
    await this.prisma.write.reconciliationRun.create({ data });
  }

  /**
   * Historial de corridas para el panel FINANCE: página de `take` filas, id desc (uuidv7 ⇒ orden temporal), con
   * cursor `id < cursor`. El WHERE del cursor se arma acá; el service resuelve hasMore/slice. Réplica.
   */
  listReconciliationRuns(opts: { cursor?: string; take: number }): Promise<ReconciliationRun[]> {
    const where: Prisma.ReconciliationRunWhereInput = {};
    if (opts.cursor) where.id = { lt: opts.cursor };
    return this.prisma.read.reconciliationRun.findMany({
      where,
      orderBy: { id: 'desc' },
      take: opts.take,
    });
  }

  // ── Poll fallback de cobros (réplica) ─────────────────────────────────────────────────────────────

  /**
   * Cobros PENDING con `externalUid` (candidatos del poll fallback), oldest-first, acotados a `batch`. El predicado
   * (PENDING + externalUid presente) va HARDCODEADO. Réplica.
   */
  findPendingPaymentsWithExternalUid(batch: number): Promise<PollablePayment[]> {
    return this.prisma.read.payment.findMany({
      where: { status: PaymentStatus.PENDING, externalUid: { not: null } },
      select: { id: true, externalUid: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: batch,
    });
  }
}
