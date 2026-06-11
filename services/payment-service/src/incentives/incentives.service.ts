/**
 * IncentivesService — incentivos al conductor y su progreso (Ola 2C).
 *
 * Vive DENTRO de payment-service (mismo bounded context "dinero": el bono es un crédito en céntimos
 * PEN, como las promos). Consume `trip.completed` (vía el consumer Kafka existente) para acumular el
 * progreso de META_VIAJES; al alcanzar la meta otorga el bono UNA sola vez (outbox `incentive.completed`).
 *
 * Idempotencia:
 *  - `IncentiveTripCredit` (UNIQUE incentiveId+driverId+tripId): un `trip.completed` re-entregado NO
 *    cuenta el viaje dos veces.
 *  - `IncentiveProgress.completedAt`: el bono se concede una sola vez por (incentivo, conductor).
 */
import { Injectable, Logger } from '@nestjs/common';
import { createEnvelope } from '@veo/events';
import { enqueueOutbox, isUniqueViolation } from '@veo/database';
import { uuidv7 } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import type { Incentive, IncentiveProgress } from '../generated/prisma';
import { computeCompleted, isActiveAt, isMetaCompleted } from './incentives.policy';

export interface DriverIncentiveView {
  id: string;
  type: 'META_VIAJES' | 'HORA_PICO';
  title: string;
  description: string;
  targetTrips: number;
  progressTrips: number;
  rewardCents: number;
  multiplierBps: number;
  expiresAt: string;
  completed: boolean;
}

@Injectable()
export class IncentivesService {
  private readonly logger = new Logger(IncentivesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Acredita un viaje completado del conductor a TODOS sus incentivos META_VIAJES vigentes.
   * Idempotente por viaje (UNIQUE crédito). Si un incentivo alcanza la meta, otorga el bono una vez
   * y emite `incentive.completed` (outbox). HORA_PICO no acumula viajes (no se ve afectado aquí).
   */
  async creditTrip(driverId: string, tripId: string): Promise<void> {
    const now = new Date();
    const incentives = await this.prisma.read.incentive.findMany({
      where: { active: true, type: 'META_VIAJES' },
    });
    for (const incentive of incentives) {
      if (!isActiveAt(incentive, now)) continue;
      await this.creditOne(incentive, driverId, tripId);
    }
  }

  /** Acredita el viaje a UN incentivo (transacción): crédito único + incremento + bono al cumplir. */
  private async creditOne(incentive: Incentive, driverId: string, tripId: string): Promise<void> {
    try {
      await this.prisma.write.$transaction(async (tx) => {
        // Crédito idempotente: si ya existe (incentivo, conductor, viaje), no cuenta de nuevo.
        await tx.incentiveTripCredit.create({
          data: { id: uuidv7(), incentiveId: incentive.id, driverId, tripId },
        });

        // Upsert del progreso + incremento atómico.
        const existing = await tx.incentiveProgress.findUnique({
          where: { incentiveId_driverId: { incentiveId: incentive.id, driverId } },
        });
        const progress: IncentiveProgress = existing
          ? await tx.incentiveProgress.update({
              where: { id: existing.id },
              data: { tripsCompleted: { increment: 1 } },
            })
          : await tx.incentiveProgress.create({
              data: { id: uuidv7(), incentiveId: incentive.id, driverId, tripsCompleted: 1 },
            });

        // ¿Alcanzó la meta y aún no se otorgó el bono? → otorgar una sola vez.
        if (!progress.completedAt && isMetaCompleted(incentive, progress.tripsCompleted)) {
          await tx.incentiveProgress.update({
            where: { id: progress.id },
            data: { completedAt: new Date(), rewardGrantedCents: incentive.rewardCents },
          });
          const envelope = createEnvelope({
            eventType: 'incentive.completed',
            producer: 'payment-service',
            dedupKey: `incentive:${incentive.id}:${driverId}`,
            payload: {
              incentiveId: incentive.id,
              driverId,
              rewardCents: incentive.rewardCents,
              tripsCompleted: progress.tripsCompleted,
              at: new Date().toISOString(),
            },
          });
          await enqueueOutbox(tx, envelope, incentive.id);
          this.logger.log(
            `Incentivo ${incentive.id} cumplido por conductor ${driverId}: bono ${incentive.rewardCents} céntimos`,
          );
        }
      });
    } catch (err) {
      // El viaje ya estaba acreditado a este incentivo (UNIQUE): idempotente, no es un error.
      if (isUniqueViolation(err)) return;
      throw err;
    }
  }

  /**
   * Incentivos VIGENTES del conductor con su progreso (Ola 2C · GET /incentives del driver-bff).
   * Ordenados por vencimiento ascendente (los que expiran antes, primero).
   */
  async listForDriver(driverId: string): Promise<DriverIncentiveView[]> {
    const now = new Date();
    const incentives = await this.prisma.read.incentive.findMany({ where: { active: true } });
    const active = incentives.filter((i) => isActiveAt(i, now));
    const progresses = await this.prisma.read.incentiveProgress.findMany({
      where: { driverId, incentiveId: { in: active.map((i) => i.id) } },
    });
    const byIncentive = new Map(progresses.map((p) => [p.incentiveId, p]));

    return active
      .map((incentive) => this.toView(incentive, byIncentive.get(incentive.id) ?? null, now))
      .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
  }

  private toView(
    incentive: Incentive,
    progress: IncentiveProgress | null,
    now: Date,
  ): DriverIncentiveView {
    // `endsAt` define el vencimiento; si es null, usamos un horizonte lejano estable (no caduca).
    const expiresAt = incentive.endsAt ?? new Date('2999-12-31T23:59:59.000Z');
    return {
      id: incentive.id,
      type: incentive.type,
      title: incentive.title,
      description: incentive.description,
      targetTrips: incentive.targetTrips,
      progressTrips: progress?.tripsCompleted ?? 0,
      rewardCents: incentive.rewardCents,
      multiplierBps: incentive.multiplierBps,
      expiresAt: expiresAt.toISOString(),
      completed: computeCompleted(incentive, progress, now),
    };
  }
}
