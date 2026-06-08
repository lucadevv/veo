/**
 * MatchingService — núcleo del matching geoespacial (BR-T06).
 *
 * Flujo al consumir `trip.requested(origin)`:
 *  1. h3(origin) res 9 y k-ring radio 1 (neighbors(cell,1)); candidatos desde el hot index (Redis).
 *  2. Excluye conductores en exclusión por pánico y los ya ofertados.
 *  3. Scoring (DispatchScorer) y orden descendente.
 *  4. Oferta SECUENCIAL al top-1 con timeout; si rechaza/expira, ofrece al siguiente.
 *  5. Si los primeros N (env, default 5) rechazan en radio 1 → expande a k-ring radio 2.
 *  6. Si alguien acepta → match_found (lo publica DispatchService.accept en la misma tx).
 *     Si se agotan candidatos → publica `dispatch.timeout`.
 *
 * SLO p99 < 1.5s request→primera oferta: los candidatos salen de Redis (no de Postgres) y el
 * cálculo de ETA con @veo/maps es por oferta (no bloquea el ranking).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  uuidv7,
  toH3,
  neighbors,
  distanceMeters,
  DISPATCH_H3_RESOLUTION,
  type LatLon,
} from '@veo/utils';
import { createEnvelope } from '@veo/events';
import { DispatchOutcome, VehicleType } from '@veo/shared-types';
import type { MapsClient } from '@veo/maps';
import { domainEventsTotal } from '@veo/observability';
import { PrismaService } from '../infra/prisma.service';
import { Prisma } from '../generated/prisma';
import { HOT_INDEX, EXCLUSION_REGISTRY, type HotIndex, type ExclusionRegistry } from '../hot-index/hot-index.port';
import { MAPS_CLIENT } from '../ports/maps/maps.module';
import { DISPATCH_SCORER } from './scorer.provider';
import { DispatchScorer, type ScoreInput } from './scoring';
import { DriverProjectionService } from './driver-projection.service';
import { SurgeService } from './surge.service';
import { OFFER_DELIVERY, type OfferDelivery } from './offer-delivery.port';
import type { Env } from '../config/env.schema';

export interface TripRequest {
  tripId: string;
  origin: LatLon;
  /**
   * Tipo de vehículo requerido (Ola 2B · tier moto-taxi). Solo se ofertan conductores cuyo vehículo
   * activo coincide (un viaje MOTO solo va a conductores MOTO; uno CAR solo a conductores CAR).
   * Default CAR si el viaje no lo especifica.
   */
  requiredVehicleType?: VehicleType;
}

export interface MatchingResult {
  matched: boolean;
  driverId?: string;
  attempts: number;
}

type ResponseOutcome = typeof DispatchOutcome.ACCEPTED | typeof DispatchOutcome.REJECTED | typeof DispatchOutcome.TIMEOUT;

interface PendingOffer {
  resolve: (outcome: ResponseOutcome) => void;
  timer: NodeJS.Timeout;
}

@Injectable()
export class MatchingService {
  private readonly logger = new Logger(MatchingService.name);
  private readonly pending = new Map<string, PendingOffer>();
  private readonly offerTimeoutMs: number;
  private readonly rejectsBeforeExpand: number;
  private readonly maxKRing: number;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(HOT_INDEX) private readonly hotIndex: HotIndex,
    @Inject(EXCLUSION_REGISTRY) private readonly exclusion: ExclusionRegistry,
    @Inject(DISPATCH_SCORER) private readonly scorer: DispatchScorer,
    private readonly projection: DriverProjectionService,
    private readonly surge: SurgeService,
    @Inject(MAPS_CLIENT) private readonly maps: MapsClient,
    @Inject(OFFER_DELIVERY) private readonly offerDelivery: OfferDelivery,
    config: ConfigService<Env, true>,
  ) {
    this.offerTimeoutMs = config.getOrThrow<number>('DISPATCH_OFFER_TIMEOUT_MS');
    this.rejectsBeforeExpand = config.getOrThrow<number>('DISPATCH_REJECTS_BEFORE_EXPAND');
    this.maxKRing = config.getOrThrow<number>('DISPATCH_MAX_K_RING');
  }

  /** Orquesta el matching de un viaje. Devuelve si hubo match y a qué conductor. */
  async handleTripRequested(trip: TripRequest): Promise<MatchingResult> {
    const center = toH3(trip.origin, DISPATCH_H3_RESOLUTION);
    const surgeQuote = await this.surge.quote(trip.origin);
    const requiredVehicleType = trip.requiredVehicleType ?? VehicleType.CAR;
    const attempted = new Set<string>();
    let attempt = 0;

    for (let k = 1; k <= this.maxKRing; k++) {
      const ranked = await this.rankCandidates(
        neighbors(center, k),
        trip.origin,
        attempted,
        requiredVehicleType,
      );
      for (const candidate of ranked) {
        // Tope de ofertas en radio 1 antes de expandir (BR-T06).
        if (k === 1 && attempt >= this.rejectsBeforeExpand) break;
        attempt++;
        attempted.add(candidate.driverId);
        const loc = candidate.location;
        const outcome = await this.offerTo({
          tripId: trip.tripId,
          driverId: candidate.driverId,
          attempt,
          score: candidate.score,
          surgeMultiplier: surgeQuote.multiplier,
          location: loc,
          origin: trip.origin,
        });
        if (outcome === DispatchOutcome.ACCEPTED) {
          await this.hotIndex.markBusy(candidate.driverId);
          return { matched: true, driverId: candidate.driverId, attempts: attempt };
        }
      }
    }

    await this.publishTimeout(trip.tripId, attempted.size);
    return { matched: false, attempts: attempted.size };
  }

  private async rankCandidates(
    cells: string[],
    origin: LatLon,
    attempted: Set<string>,
    requiredVehicleType: VehicleType,
  ): Promise<{ driverId: string; score: number; location: LatLon }[]> {
    const locations = await this.hotIndex.candidates(cells);
    // Ola 2B · tier moto-taxi: solo conductores cuyo vehículo activo coincide con el requerido.
    const matchingType = locations.filter((l) => l.vehicleType === requiredVehicleType);
    const fresh = matchingType.filter((l) => !attempted.has(l.driverId));
    const allowedIds = await this.exclusion.filter(fresh.map((l) => l.driverId));
    const allowed = new Set(allowedIds);
    const usable = fresh.filter((l) => allowed.has(l.driverId));
    if (usable.length === 0) return [];

    const stats = await this.projection.getStats(usable.map((l) => l.driverId));
    const inputs: ScoreInput[] = usable.map((loc) => {
      const s = stats.get(loc.driverId);
      return {
        driverId: loc.driverId,
        distanceMeters: distanceMeters({ lat: loc.lat, lon: loc.lon }, origin),
        avgRating: s?.avgRating ?? 5.0,
        secondsSinceLastTrip: s?.secondsSinceLastTrip ?? 1_000_000_000,
        cancellationRate: s?.cancellationRate ?? 0,
      };
    });
    const byId = new Map(usable.map((l) => [l.driverId, { lat: l.lat, lon: l.lon }]));
    return this.scorer.rank(inputs).map((c) => ({
      driverId: c.driverId,
      score: c.score,
      location: byId.get(c.driverId) ?? origin,
    }));
  }

  private async offerTo(args: {
    tripId: string;
    driverId: string;
    attempt: number;
    score: number;
    surgeMultiplier: number;
    location: LatLon;
    origin: LatLon;
  }): Promise<ResponseOutcome> {
    const matchId = uuidv7();
    await this.prisma.write.dispatchMatch.create({
      data: {
        id: matchId,
        tripId: args.tripId,
        driverId: args.driverId,
        score: new Prisma.Decimal(args.score),
        attempt: args.attempt,
        surgeMultiplier: new Prisma.Decimal(args.surgeMultiplier),
        outcome: DispatchOutcome.OFFERED,
      },
    });

    // ETA self-hosted (@veo/maps, NO Google). Una llamada por oferta; no bloquea el ranking.
    let etaSeconds = 0;
    try {
      etaSeconds = await this.maps.eta(args.location, args.origin);
    } catch (err) {
      this.logger.warn(`ETA no disponible para match ${matchId}: ${String(err)}`);
    }

    // El conductor debe responder antes de offeredAt + timeout; la app lo usa como cuenta atrás.
    const expiresAt = new Date(Date.now() + this.offerTimeoutMs).toISOString();
    const outcome = await new Promise<ResponseOutcome>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(matchId)) return;
        void this.expireOffer(matchId);
        resolve(DispatchOutcome.TIMEOUT);
      }, this.offerTimeoutMs);
      this.pending.set(matchId, { resolve, timer });
      void Promise.resolve(
        this.offerDelivery.deliver({
          matchId,
          tripId: args.tripId,
          driverId: args.driverId,
          etaSeconds,
          attempt: args.attempt,
          score: args.score,
          surgeMultiplier: args.surgeMultiplier,
          expiresAt,
        }),
      ).catch((err) => this.logger.warn(`entrega de oferta falló (${matchId}): ${String(err)}`));
    });
    return outcome;
  }

  /** Resuelve una oferta pendiente (lo invoca DispatchService.accept/reject). */
  respond(matchId: string, outcome: typeof DispatchOutcome.ACCEPTED | typeof DispatchOutcome.REJECTED): void {
    const offer = this.pending.get(matchId);
    if (!offer) return; // ya resuelta o expirada
    clearTimeout(offer.timer);
    this.pending.delete(matchId);
    offer.resolve(outcome);
  }

  private async expireOffer(matchId: string): Promise<void> {
    try {
      await this.prisma.write.dispatchMatch.updateMany({
        where: { id: matchId, outcome: DispatchOutcome.OFFERED },
        data: { outcome: DispatchOutcome.TIMEOUT, respondedAt: new Date() },
      });
    } catch (err) {
      this.logger.warn(`no se pudo marcar TIMEOUT del match ${matchId}: ${String(err)}`);
    }
  }

  private async publishTimeout(tripId: string, attemptedDrivers: number): Promise<void> {
    const envelope = createEnvelope({
      eventType: 'dispatch.timeout',
      producer: 'dispatch-service',
      payload: { tripId, attemptedDrivers },
    });
    await this.prisma.write.$transaction(async (tx) => {
      await tx.outboxEvent.create({
        data: {
          aggregateId: tripId,
          eventType: envelope.eventType,
          envelope: envelope as unknown as Prisma.InputJsonValue,
        },
      });
    });
    domainEventsTotal.inc({ event: 'dispatch.timeout', result: 'published' });
  }
}
