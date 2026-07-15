/**
 * IncentivesRepository — ÚNICO punto de acceso Prisma del agregado de incentivos (schema 'payment'). Espeja
 * `payments.repository.ts`: encapsula el read/write split (réplica vs primary), el patrón OUTBOX-EN-TRANSACCIÓN
 * (el otorgamiento del bono y el INSERT de `incentive.completed` van en la MISMA tx Prisma, FOUNDATION §6) y
 * expone métodos con NOMBRES DE DOMINIO — nunca filtra `PrismaClient` crudo hacia el service.
 *
 * SEAM con IncentivesService: la LÓGICA (acumulación de progreso, decisión de cumplir la meta, one-shot del bono,
 * filtrado de HORA_PICO) vive ENTERA en el service. Este repo solo hace acceso a datos y CRISTALIZA los
 * INVARIANTES DE QUERY:
 *   - la creación del crédito por viaje (`IncentiveTripCredit`) es el GUARD de idempotencia: su UNIQUE
 *     (incentiveId+driverId+tripId) aborta la tx si el `trip.completed` se re-entregó (el viaje no cuenta dos veces);
 *   - `incentive.completed` se persiste al outbox DENTRO de la misma tx que otorga el bono (atomicidad bono↔evento).
 *
 * Como acreditar el viaje interleava crédito + progreso + bono + outbox DENTRO de una transacción, el repo expone
 * `runInTransaction(work)` (dueño del `$transaction`) + métodos tx-scoped que reciben el `tx` opaco: el service
 * ORQUESTA la secuencia sin tocar nunca `this.prisma` ni `tx.model.op`.
 */
import { Injectable } from '@nestjs/common';
import { enqueueOutbox as persistOutboxEvent } from '@veo/database';
import type { EventEnvelope } from '@veo/events';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type Incentive, type IncentiveProgress } from '../generated/prisma';

/** Handle de transacción opaco para el service: forwardea el `tx` a los métodos del repo, no lo dereferencia. */
export type IncentiveTx = Prisma.TransactionClient;

@Injectable()
export class IncentivesRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Lecturas (réplica) ──────────────────────────────────────────────────────────────────────────────

  /** Incentivos META_VIAJES activos (candidatos a acumular un viaje). Réplica. */
  findActiveMetaIncentives(): Promise<Incentive[]> {
    return this.prisma.read.incentive.findMany({
      where: { active: true, type: 'META_VIAJES' },
    });
  }

  /** Todos los incentivos activos (el service filtra vigencia/HORA_PICO). Réplica. */
  findActiveIncentives(): Promise<Incentive[]> {
    return this.prisma.read.incentive.findMany({ where: { active: true } });
  }

  /** Progreso del conductor en los incentivos dados (para armar la vista). Réplica. */
  findProgressForDriver(driverId: string, incentiveIds: string[]): Promise<IncentiveProgress[]> {
    return this.prisma.read.incentiveProgress.findMany({
      where: { driverId, incentiveId: { in: incentiveIds } },
    });
  }

  // ── Transacciones (primary · unit-of-work) ──────────────────────────────────────────────────────────

  /**
   * Dueño del `$transaction` (write). El service pasa `work`, que ORQUESTA crédito → progreso → bono → outbox
   * como una única unidad ACID (outbox-en-transacción).
   */
  runInTransaction<T>(work: (tx: IncentiveTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(work);
  }

  /** Persiste un evento en el outbox DENTRO de la tx (FOUNDATION §6). El service arma el envelope. */
  async enqueueOutbox(
    tx: IncentiveTx,
    envelope: EventEnvelope<unknown>,
    aggregateId: string,
  ): Promise<void> {
    await persistOutboxEvent(tx, envelope, aggregateId);
  }

  /**
   * Crea el crédito del viaje DENTRO de la tx: GUARD de idempotencia (UNIQUE incentiveId+driverId+tripId → un
   * `trip.completed` re-entregado aborta la tx). El service arma la data.
   */
  async createTripCreditInTx(
    tx: IncentiveTx,
    data: Prisma.IncentiveTripCreditUncheckedCreateInput,
  ): Promise<void> {
    await tx.incentiveTripCredit.create({ data });
  }

  /** Progreso (incentivo, conductor) DENTRO de la tx (base del upsert + incremento). */
  findProgressInTx(
    tx: IncentiveTx,
    incentiveId: string,
    driverId: string,
  ): Promise<IncentiveProgress | null> {
    return tx.incentiveProgress.findUnique({
      where: { incentiveId_driverId: { incentiveId, driverId } },
    });
  }

  /** Incrementa el progreso en 1 viaje DENTRO de la tx (increment atómico). Devuelve la fila actualizada. */
  incrementProgressInTx(tx: IncentiveTx, id: string): Promise<IncentiveProgress> {
    return tx.incentiveProgress.update({
      where: { id },
      data: { tripsCompleted: { increment: 1 } },
    });
  }

  /** Crea el progreso inicial (primer viaje) DENTRO de la tx. El service arma la data. */
  createProgressInTx(
    tx: IncentiveTx,
    data: Prisma.IncentiveProgressUncheckedCreateInput,
  ): Promise<IncentiveProgress> {
    return tx.incentiveProgress.create({ data });
  }

  /**
   * Otorga el bono (one-shot) DENTRO de la tx: marca `completedAt` y persiste `rewardGrantedCents`. El service
   * decide CUÁNDO llamar (meta alcanzada y aún sin otorgar); el repo sella la escritura con el timestamp.
   */
  async grantRewardInTx(
    tx: IncentiveTx,
    progressId: string,
    rewardGrantedCents: number,
  ): Promise<void> {
    await tx.incentiveProgress.update({
      where: { id: progressId },
      data: { completedAt: new Date(), rewardGrantedCents },
    });
  }
}
