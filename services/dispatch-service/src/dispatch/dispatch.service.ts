/**
 * DispatchService — respuestas a ofertas (accept/reject), lectura de matches, ingestión de
 * ubicación y prioridad de pánico (BR-T06).
 *
 * `accept` es la mutación de dominio que finaliza la asignación: en la MISMA transacción marca el
 * match ACCEPTED y encola `dispatch.match_found` en el outbox (FOUNDATION §6). Tras commitear,
 * resuelve la oferta pendiente del MatchingService para que el bucle de matching se detenga.
 */
import { Inject, Injectable } from '@nestjs/common';
import { createEnvelope } from '@veo/events';
import { uuidv7, ConflictError, NotFoundError, type LatLon } from '@veo/utils';
import { DispatchOutcome, type VehicleType } from '@veo/shared-types';
import { domainEventsTotal } from '@veo/observability';
import { PrismaService } from '../infra/prisma.service';
import { Prisma } from '../generated/prisma';
import { HOT_INDEX, EXCLUSION_REGISTRY, type HotIndex, type ExclusionRegistry } from '../hot-index/hot-index.port';
import { MatchingService } from './matching.service';

export interface MatchView {
  id: string;
  tripId: string;
  driverId: string;
  score: number;
  attempt: number;
  surgeMultiplier: number;
  outcome: DispatchOutcome;
  offeredAt: string;
  respondedAt: string | null;
}

@Injectable()
export class DispatchService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(HOT_INDEX) private readonly hotIndex: HotIndex,
    @Inject(EXCLUSION_REGISTRY) private readonly exclusion: ExclusionRegistry,
    private readonly matching: MatchingService,
  ) {}

  async accept(matchId: string): Promise<MatchView> {
    const view = await this.prisma.write.$transaction(async (tx) => {
      const match = await tx.dispatchMatch.findUnique({ where: { id: matchId } });
      if (!match) throw new NotFoundError('Oferta no encontrada');
      if (match.outcome !== DispatchOutcome.OFFERED) {
        throw new ConflictError('La oferta ya fue respondida o expiró', { outcome: match.outcome });
      }
      const respondedAt = new Date();
      const updated = await tx.dispatchMatch.update({
        where: { id: matchId },
        data: { outcome: DispatchOutcome.ACCEPTED, respondedAt },
      });
      const scoreMs = respondedAt.getTime() - match.offeredAt.getTime();
      const envelope = createEnvelope({
        eventType: 'dispatch.match_found',
        producer: 'dispatch-service',
        payload: { tripId: match.tripId, driverId: match.driverId, scoreMs },
        dedupKey: uuidv7(),
      });
      await tx.outboxEvent.create({
        data: {
          aggregateId: match.tripId,
          eventType: envelope.eventType,
          envelope: envelope as unknown as Prisma.InputJsonValue,
        },
      });
      return DispatchService.toView(updated);
    });

    await this.hotIndex.markBusy(view.driverId);
    this.matching.respond(matchId, DispatchOutcome.ACCEPTED);
    domainEventsTotal.inc({ event: 'dispatch.match_found', result: 'published' });
    return view;
  }

  async reject(matchId: string): Promise<MatchView> {
    const view = await this.prisma.write.$transaction(async (tx) => {
      const match = await tx.dispatchMatch.findUnique({ where: { id: matchId } });
      if (!match) throw new NotFoundError('Oferta no encontrada');
      if (match.outcome !== DispatchOutcome.OFFERED) {
        throw new ConflictError('La oferta ya fue respondida o expiró', { outcome: match.outcome });
      }
      const updated = await tx.dispatchMatch.update({
        where: { id: matchId },
        data: { outcome: DispatchOutcome.REJECTED, respondedAt: new Date() },
      });
      return DispatchService.toView(updated);
    });

    this.matching.respond(matchId, DispatchOutcome.REJECTED);
    return view;
  }

  async getMatch(matchId: string): Promise<MatchView> {
    const match = await this.prisma.read.dispatchMatch.findUnique({ where: { id: matchId } });
    if (!match) throw new NotFoundError('Match no encontrado');
    return DispatchService.toView(match);
  }

  /**
   * Ingestión de un ping de ubicación (consumido de driver.location_updated). `vehicleType` (Ola 2B)
   * refleja el vehículo activo del conductor y se persiste en el hot index para filtrar el matching.
   */
  async ingestLocation(driverId: string, point: LatLon, vehicleType?: VehicleType): Promise<void> {
    await this.hotIndex.upsertLocation(driverId, point, vehicleType);
  }

  /**
   * Prioridad de pánico (BR-T06): excluye al conductor del viaje en pánico del pool de ofertas
   * hasta su resolución. NO hay reasignación automática.
   */
  async excludeDriverForPanic(tripId: string): Promise<string | null> {
    const match = await this.prisma.read.dispatchMatch.findFirst({
      where: { tripId, outcome: DispatchOutcome.ACCEPTED },
      orderBy: { respondedAt: 'desc' },
    });
    if (!match) return null;
    await this.exclusion.exclude(match.driverId);
    return match.driverId;
  }

  /** Tras completar el viaje, el conductor vuelve al pool disponible. */
  async releaseDriver(driverId: string): Promise<void> {
    await this.hotIndex.markAvailable(driverId);
  }

  /** Resuelve el conductor asignado a un viaje (para proyección en trip.completed/cancelled). */
  async driverForTrip(tripId: string): Promise<string | null> {
    const match = await this.prisma.read.dispatchMatch.findFirst({
      where: { tripId, outcome: DispatchOutcome.ACCEPTED },
      orderBy: { respondedAt: 'desc' },
    });
    return match?.driverId ?? null;
  }

  private static toView(match: {
    id: string;
    tripId: string;
    driverId: string;
    score: { toString(): string };
    attempt: number;
    surgeMultiplier: { toString(): string };
    outcome: string;
    offeredAt: Date;
    respondedAt: Date | null;
  }): MatchView {
    return {
      id: match.id,
      tripId: match.tripId,
      driverId: match.driverId,
      score: Number(match.score.toString()),
      attempt: match.attempt,
      surgeMultiplier: Number(match.surgeMultiplier.toString()),
      outcome: match.outcome as DispatchOutcome,
      offeredAt: match.offeredAt.toISOString(),
      respondedAt: match.respondedAt ? match.respondedAt.toISOString() : null,
    };
  }
}
