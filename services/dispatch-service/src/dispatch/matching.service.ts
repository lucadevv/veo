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
 *     Si se agotan candidatos → publica `dispatch.no_offers` (reason `no_candidates`).
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
import {
  DispatchOutcome,
  findOffering,
  OfferingFlow,
  type OfferingRequirements,
  type VehicleClass,
} from '@veo/shared-types';
import type { MapsClient } from '@veo/maps';
import { domainEventsTotal } from '@veo/observability';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, DispatchSessionStatus, type DispatchSession } from '../generated/prisma';
import { DriverPool } from './driver-pool';
import { MatchingSessionStore } from './matching-session.store';
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
   * Clase de vehículo requerida (ADR 013 · key del pool de matching). Solo se ofertan conductores
   * cuya clase activa coincide (un viaje MOTO solo va a conductores MOTO; uno CAR solo a CAR).
   * OBLIGATORIA (Lote D): el default legacy para eventos viejos vive en el borde Kafka
   * (kafka-consumers), no acá — un caller nuevo no puede omitirla y caer silencioso a CAR.
   */
  requiredVehicleType: VehicleClass;
  /**
   * B5-3 · oferta del viaje (offeringId): el matching resuelve sus requisitos de eligibilidad para
   * filtrar el pool (confort=segment≥MID, xl=6 asientos). Opcional: ausente/desconocida ⇒ sin requisitos.
   */
  category?: string;
}

@Injectable()
export class MatchingService {
  private readonly logger = new Logger(MatchingService.name);
  private readonly offerTimeoutMs: number;
  private readonly maxKRing: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly driverPool: DriverPool,
    private readonly sessions: MatchingSessionStore,
    @Inject(DISPATCH_SCORER) private readonly scorer: DispatchScorer,
    private readonly projection: DriverProjectionService,
    private readonly surge: SurgeService,
    @Inject(MAPS_CLIENT) private readonly maps: MapsClient,
    @Inject(OFFER_DELIVERY) private readonly offerDelivery: OfferDelivery,
    config: ConfigService<Env, true>,
  ) {
    this.offerTimeoutMs = config.getOrThrow<number>('DISPATCH_OFFER_TIMEOUT_MS');
    this.maxKRing = config.getOrThrow<number>('DISPATCH_MAX_K_RING');
  }

  // ──────────────── Matching EVENT-DRIVEN (estado durable, sin Promise/timer en proceso) ────────────────

  /**
   * Inicia (o re-inicia, en un re-bid) la sesión de matching del viaje y dispara la PRIMERA oferta.
   * Reemplaza al await-loop in-process: desde acá el matching avanza por ESTADO en DB (offerNext), no por
   * un Promise/timer en memoria. Idempotente: una redelivery re-abre la sesión y vuelve a ofertar.
   */
  async startSession(trip: TripRequest): Promise<void> {
    await this.sessions.start({
      tripId: trip.tripId,
      origin: trip.origin,
      vehicleType: trip.requiredVehicleType,
      category: trip.category,
    });
    await this.offerNext(trip.tripId);
  }

  /**
   * Avanza el matching: oferta al SIGUIENTE candidato elegible, o cierra TIMED_OUT si se agotaron. STATELESS
   * y replica-safe — lo invocan startSession, el reject del conductor (D2.2) y el reconciler (D2.3). Guardas:
   * la sesión debe estar OPEN y NO debe haber una oferta en vuelo (una oferta a la vez).
   */
  async offerNext(tripId: string): Promise<void> {
    const session = await this.sessions.get(tripId);
    // `session?.status !== OPEN` cubre la inexistente (undefined) y la cerrada en una sola comparación.
    if (session?.status !== DispatchSessionStatus.OPEN) return; // no-op

    // B5-vert · EMERGENCIA (ambulancia): despacho por BROADCAST simultáneo, no secuencial. Bifurca ACÁ;
    // el flujo STANDARD (de acá para abajo) queda intacto. El flow se deriva de la oferta del viaje.
    if (this.offeringFlow(session.category) === OfferingFlow.EMERGENCY) {
      return this.offerBroadcast(tripId, session);
    }

    // Una oferta a la vez: si hay un OFFERED vivo no encimamos otra (la respuesta o el reconciler avanzan).
    const inFlight = await this.prisma.read.dispatchMatch.count({
      where: { tripId, outcome: DispatchOutcome.OFFERED },
    });
    if (inFlight > 0) return;

    // "Ya ofertados" = matches de ESTA ronda (offeredAt ≥ inicio de la sesión); un re-bid no los hereda.
    const priorMatches = await this.prisma.read.dispatchMatch.findMany({
      where: { tripId, offeredAt: { gte: session.createdAt } },
      select: { driverId: true },
    });
    const attempted = new Set(priorMatches.map((m) => m.driverId));

    const origin: LatLon = { lat: session.originLat, lon: session.originLon };
    const center = toH3(origin, DISPATCH_H3_RESOLUTION);
    // B5-3 · requisitos de eligibilidad de la oferta del viaje (segment/seats/antigüedad). Si la category
    // está ausente o no matchea el catálogo, `findOffering` da undefined ⇒ el pool no restringe (degradación).
    const requires = findOffering(session.category ?? '')?.requires;
    // Rankea desde el k-ring actual; si está agotado, expande (persistiendo el avance) y reintenta.
    for (let k = session.currentKRing; k <= this.maxKRing; k++) {
      const ranked = await this.rankCandidates(neighbors(center, k), origin, attempted, session.vehicleType, requires);
      const top = ranked[0];
      if (!top) continue;
      if (k !== session.currentKRing) await this.sessions.bumpKRing(tripId, k);
      const surgeQuote = await this.surge.quote(origin);
      await this.createAndDeliverOffer({
        tripId,
        candidate: top,
        surgeMultiplier: surgeQuote.multiplier,
        attempt: attempted.size + 1,
        origin,
      });
      return;
    }

    // Sin candidatos hasta maxKRing → cierre honesto + dispatch.no_offers (idempotente por el CAS del cierre).
    if (await this.sessions.closeTimedOut(tripId)) {
      await this.publishNoCandidates(tripId, attempted.size);
    }
  }

  /**
   * Deriva el FLUJO de despacho de la oferta del viaje (ADR 013). EMERGENCY = ambulancia (broadcast,
   * prioridad). Sin category o desconocida ⇒ STANDARD (el flujo secuencial de siempre).
   */
  private offeringFlow(category: string | null): OfferingFlow {
    return findOffering(category ?? '')?.flow ?? OfferingFlow.STANDARD;
  }

  /**
   * Despacho de EMERGENCIA (ambulancia · OfferingFlow.EMERGENCY): oferta SIMULTÁNEA a TODOS los conductores
   * elegibles del radio (no uno a la vez). El primero que acepta gana — la carrera la zanjan el CAS del
   * accept + el índice UNIQUE PARCIAL (un solo ACCEPTED por viaje) + el CAS de cierre de sesión; los
   * perdedores reciben offer_withdrawn (DispatchService.accept). Búsqueda AMPLIA de una (disco maxKRing),
   * no expansión incremental: una emergencia no espera rondas. STATELESS y replica-safe (idempotente por
   * el set de ya-ofertados). NO usa la guarda "una-oferta-a-la-vez": el broadcast son N ofertas vivas.
   */
  private async offerBroadcast(tripId: string, session: DispatchSession): Promise<void> {
    // Ofertados de ESTA ronda (vivos OFFERED + ya respondidos): no re-ofertar al mismo conductor.
    const priorMatches = await this.prisma.read.dispatchMatch.findMany({
      where: { tripId, offeredAt: { gte: session.createdAt } },
      select: { driverId: true, outcome: true },
    });
    const attempted = new Set(priorMatches.map((m) => m.driverId));
    const liveOffers = priorMatches.filter((m) => m.outcome === DispatchOutcome.OFFERED).length;

    const origin: LatLon = { lat: session.originLat, lon: session.originLon };
    const center = toH3(origin, DISPATCH_H3_RESOLUTION);
    const requires = findOffering(session.category ?? '')?.requires;
    // Disco completo hasta maxKRing de una (gridDisk acumulado): cobertura amplia inmediata para la emergencia.
    const ranked = await this.rankCandidates(
      neighbors(center, this.maxKRing),
      origin,
      attempted,
      session.vehicleType,
      requires,
    );

    if (ranked.length === 0) {
      // Nadie NUEVO a quien ofertar. Si tampoco quedan ofertas vivas → cierre honesto (no_offers). Si aún
      // hay vivas, esperamos su respuesta/expiración (el sweep re-invoca offerNext cuando alguna caduca).
      if (liveOffers === 0 && (await this.sessions.closeTimedOut(tripId))) {
        await this.publishNoCandidates(tripId, attempted.size);
      }
      return;
    }

    const surgeQuote = await this.surge.quote(origin);
    let attempt = attempted.size;
    // Broadcast en paralelo (patrón del board PUJA): una oferta a cada candidato nuevo. Un fallo de entrega
    // individual NO aborta el resto (la oferta queda OFFERED en DB; el conductor la ve por el poll/backstop).
    await Promise.all(
      ranked.map((candidate) => {
        attempt += 1;
        return this.createAndDeliverOffer({
          tripId,
          candidate,
          surgeMultiplier: surgeQuote.multiplier,
          attempt,
          origin,
        }).catch((err) =>
          this.logger.warn(`broadcast EMERGENCY a ${candidate.driverId} falló: ${String(err)}`),
        );
      }),
    );
  }

  /** Cierra la sesión del viaje como MATCHED (un conductor aceptó). Idempotente (CAS where status=OPEN). */
  async markMatched(tripId: string): Promise<void> {
    await this.sessions.closeMatched(tripId);
  }

  /** Cierra la sesión como CANCELLED (el viaje se canceló durante el matching). Idempotente (CAS). */
  async cancelSession(tripId: string): Promise<void> {
    await this.sessions.closeCancelled(tripId);
  }

  /**
   * Barrido DURABLE de ofertas vencidas (D2.3): reemplaza al setTimeout en proceso. Para cada oferta
   * OFFERED más vieja que el timeout, la reclama a TIMEOUT por CAS atómico (where outcome=OFFERED) y
   * avanza el matching (offerNext). Replica-safe: el CAS garantiza que UNA sola réplica toma cada oferta
   * (las demás ven count=0). Lo invoca el reconciler (@Interval). Devuelve cuántas avanzó.
   */
  async sweepExpiredOffers(limit = 100): Promise<number> {
    const cutoff = new Date(Date.now() - this.offerTimeoutMs);
    const expired = await this.prisma.read.dispatchMatch.findMany({
      where: { outcome: DispatchOutcome.OFFERED, offeredAt: { lt: cutoff } },
      select: { id: true, tripId: true },
      orderBy: { offeredAt: 'asc' },
      take: limit,
    });
    let advanced = 0;
    for (const m of expired) {
      const claimed = await this.prisma.write.dispatchMatch.updateMany({
        where: { id: m.id, outcome: DispatchOutcome.OFFERED },
        data: { outcome: DispatchOutcome.TIMEOUT, respondedAt: new Date() },
      });
      if (claimed.count === 0) continue; // otra réplica (o un accept/reject) ya la tomó
      await this.offerNext(m.tripId); // re-chequea sesión OPEN + una-oferta-a-la-vez
      advanced += 1;
    }
    return advanced;
  }

  /**
   * Persiste UNA oferta (DispatchMatch OFFERED) y la entrega al conductor. SIN Promise/timer en proceso:
   * el desenlace (accept/reject/timeout) llega por ESTADO en DB (dispatch.service / el reconciler).
   */
  private async createAndDeliverOffer(args: {
    tripId: string;
    candidate: { driverId: string; score: number; location: LatLon };
    surgeMultiplier: number;
    attempt: number;
    origin: LatLon;
  }): Promise<void> {
    const matchId = uuidv7();
    await this.prisma.write.dispatchMatch.create({
      data: {
        id: matchId,
        tripId: args.tripId,
        driverId: args.candidate.driverId,
        score: new Prisma.Decimal(args.candidate.score),
        attempt: args.attempt,
        surgeMultiplier: new Prisma.Decimal(args.surgeMultiplier),
        outcome: DispatchOutcome.OFFERED,
      },
    });
    let etaSeconds = 0;
    try {
      etaSeconds = await this.maps.eta(args.candidate.location, args.origin);
    } catch (err) {
      this.logger.warn(`ETA no disponible para match ${matchId}: ${String(err)}`);
    }
    const expiresAt = new Date(Date.now() + this.offerTimeoutMs).toISOString();
    try {
      await this.offerDelivery.deliver({
        matchId,
        tripId: args.tripId,
        driverId: args.candidate.driverId,
        etaSeconds,
        attempt: args.attempt,
        score: args.candidate.score,
        surgeMultiplier: args.surgeMultiplier,
        expiresAt,
      });
    } catch (err) {
      this.logger.warn(`entrega de oferta falló (${matchId}): ${String(err)}`);
    }
  }

  private async rankCandidates(
    cells: string[],
    origin: LatLon,
    attempted: Set<string>,
    requiredVehicleType: VehicleClass,
    requires?: OfferingRequirements,
  ): Promise<{ driverId: string; score: number; location: LatLon }[]> {
    // Candidatos elegibles (disponibles + del tipo requerido + que cumplen el `requires` de la oferta +
    // no excluidos por pánico + no ya ofertados). Filtrado centralizado en DriverPool (misma fuente que PUJA).
    const usable = await this.driverPool.eligible(cells, requiredVehicleType, { exclude: attempted, requires });
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

  /**
   * El matcher secuencial (FIXED) agotó el k-ring sin candidatos → emite `dispatch.no_offers` (reason
   * `no_candidates`), el EVENTO UNIFICADO de "sin conductor" que trip-service YA consume (puja.consumer →
   * expireFromNoOffers → EXPIRED instantáneo). Reemplaza al viejo `dispatch.timeout` (que no tenía consumer
   * → el FIXED solo cerraba por el watchdog en minutos). `attemptedDrivers` queda como label de métrica
   * (cuántos conductores se intentaron antes de cerrar), no en el payload (no_offers solo lleva tripId+reason).
   */
  private async publishNoCandidates(tripId: string, attemptedDrivers: number): Promise<void> {
    const envelope = createEnvelope({
      eventType: 'dispatch.no_offers',
      producer: 'dispatch-service',
      payload: { tripId, reason: 'no_candidates' },
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
    domainEventsTotal.inc({ event: 'dispatch.no_offers', result: 'published' });
    this.logger.log(`matcher FIXED sin candidatos para ${tripId} (intentados ${attemptedDrivers}) → no_offers`);
  }
}
