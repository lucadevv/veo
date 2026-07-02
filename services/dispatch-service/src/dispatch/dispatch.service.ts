/**
 * DispatchService — respuestas a ofertas (accept/reject), lectura de matches, ingestión de
 * ubicación y prioridad de pánico (BR-T06).
 *
 * `accept` es la mutación de dominio que finaliza la asignación: en la MISMA transacción marca el
 * match ACCEPTED y encola `dispatch.match_found` en el outbox (FOUNDATION §6). Tras commitear,
 * resuelve la oferta pendiente del MatchingService para que el bucle de matching se detenga.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createEnvelope } from '@veo/events';
import { isUniqueViolation } from '@veo/database';
import { ConflictError, NotFoundError, type LatLon } from '@veo/utils';
import { DispatchOutcome, type VehicleClass } from '@veo/shared-types';
import { PrismaService } from '../infra/prisma.service';
import { Prisma } from '../generated/prisma';
import {
  HOT_INDEX,
  EXCLUSION_REGISTRY,
  type HotIndex,
  type ExclusionRegistry,
  type DriverVehicleAttrs,
} from '../hot-index/hot-index.port';
import { FLEET_CLIENT, type FleetClient } from '../fleet/fleet-client.port';
import { IDENTITY_CLIENT, type IdentityClient } from '../identity/identity-client.port';
import { MatchingService } from './matching.service';
import { EligibilityGate } from './eligibility.gate';

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
  private readonly logger = new Logger(DispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(HOT_INDEX) private readonly hotIndex: HotIndex,
    @Inject(EXCLUSION_REGISTRY) private readonly exclusion: ExclusionRegistry,
    @Inject(FLEET_CLIENT) private readonly fleet: FleetClient,
    @Inject(IDENTITY_CLIENT) private readonly identity: IdentityClient,
    private readonly matching: MatchingService,
    private readonly eligibility: EligibilityGate,
  ) {}

  /**
   * Resuelve el vehículo activo del conductor (fail-soft: null si algo falla, NO bloquea la asignación).
   * MAPEO CRÍTICO: el match trae el `Driver.id` (entidad), pero fleet indexa los vehículos por `User.id`
   * (el sujeto de la identidad propagada — fleet no conoce el id de perfil Driver). Así que primero
   * `identity.GetDriver(driverId) → userId` y recién con ESE userId pegamos a fleet. Sin el mapeo,
   * GetDriverVehicles devolvía vacío SIEMPRE (bug latente que tapaba el auto en ofertas y viaje).
   */
  private async resolveVehicleId(driverId: string): Promise<string | null> {
    try {
      const driver = await this.identity.getDriver(driverId);
      if (!driver.found) return null;
      return await this.fleet.getActiveVehicleId(driver.userId);
    } catch (err) {
      this.logger.warn(
        `No se pudo resolver el vehículo del conductor ${driverId} (asigno sin vehicleId): ${String(err)}`,
      );
      return null;
    }
  }

  async accept(matchId: string, driverId: string): Promise<MatchView> {
    // Resolvemos el vehículo activo del conductor ANTES de la transacción (no hacemos I/O de red dentro
    // de la tx). El claim atómico de abajo sigue garantizando la concurrencia; resolver para un accept
    // perdedor es trabajo descartado pero inofensivo. Fail-soft: si fleet no responde, vehicleId = null
    // y la asignación NO se bloquea (la trazabilidad es deseable, no bloqueante del viaje).
    const pre = await this.prisma.read.dispatchMatch.findUnique({ where: { id: matchId } });
    // Ownership-check (anti-IDOR #9): un conductor que conoce el matchId de OTRO recibe 404 (NO 403:
    // no filtramos existencia). El driverId viene de la identidad FIRMADA, no del cliente.
    if (pre?.driverId !== driverId) throw new NotFoundError('Oferta no encontrada');
    // ASIMETRÍA FIXED↔PUJA (ALTA del gate wvv7pn1z0): re-validamos que el conductor esté ACTIVO
    // (online + !suspendido) contra identity, IGUAL que el accept de PUJA (offer-board:499). El path
    // FIXED confiaba SOLO en la presencia GPS del hot-index (stale): un conductor suspendido que seguía
    // pingeando recibía y aceptaba ofertas. `fresh=true`: decisión de plata, sin cache (un recién-
    // suspendido no se cuela por un snapshot stale). Falla-cerrado: identity caído ⇒ 403. Va ANTES del
    // resolveVehicleId para no pegarle a fleet por un conductor inelegible.
    await this.eligibility.assertActiveDriver(driverId, true);
    const vehicleId = await this.resolveVehicleId(pre.driverId);

    const view = await this.prisma.write.$transaction(async (tx) => {
      const match = await tx.dispatchMatch.findUnique({ where: { id: matchId } });
      // Re-chequeo de ownership dentro de la tx (404 si desapareció o no es del dueño). Esto NO es la
      // señal de concurrencia: el dueño legítimo que llega TARDE pasa este check y cae en el CAS de abajo.
      if (match?.driverId !== driverId) throw new NotFoundError('Oferta no encontrada');
      const respondedAt = new Date();
      // Guard ATÓMICO (no check-then-act): outcome + driverId van en el WHERE. Dos accepts concurrentes del
      // MISMO dueño → solo UNO matchea OFFERED y gana; el que llega tarde ve count=0 → 409 Conflict
      // (idempotencia honesta). El driverId en el WHERE es defensa en profundidad sobre el ownership-check.
      let claimed: { count: number };
      try {
        claimed = await tx.dispatchMatch.updateMany({
          where: { id: matchId, driverId, outcome: DispatchOutcome.OFFERED },
          data: { outcome: DispatchOutcome.ACCEPTED, respondedAt },
        });
      } catch (err) {
        // BROADCAST EMERGENCY (B5-vert): dos conductores aceptan ofertas DISTINTAS del MISMO viaje casi a la
        // vez; ambos pasan su CAS de match (matchIds distintos OFFERED), pero el índice UNIQUE PARCIAL
        // (trip_id WHERE outcome='ACCEPTED') deja que solo UNO quede ACCEPTED — el 2º viola el unique.
        // Lo traducimos a 409 limpio (no un 500). Helper ESTRUCTURAL (@veo/database): el `instanceof` del
        // cliente generado por servicio no matchearía cross-cliente. En el secuencial este path no se da.
        if (isUniqueViolation(err, 'trip_id')) {
          throw new ConflictError('La emergencia ya fue tomada por otro conductor', {
            tripId: match.tripId,
          });
        }
        throw err;
      }
      if (claimed.count === 0) {
        // count===0 acá = el DUEÑO ya validado llega tarde sobre un match ya respondido/expirado → 409.
        // NO se confunde con el 404-no-dueño de arriba: ese ya cortó antes del CAS.
        throw new ConflictError('La oferta ya fue respondida o expiró', { outcome: match.outcome });
      }
      const scoreMs = respondedAt.getTime() - match.offeredAt.getTime();
      const envelope = createEnvelope({
        eventType: 'dispatch.match_found',
        producer: 'dispatch-service',
        // vehicleId adjunto (si se resolvió) → trip-service lo persiste en el viaje (trazabilidad).
        payload: {
          tripId: match.tripId,
          driverId: match.driverId,
          vehicleId: vehicleId ?? undefined,
          scoreMs,
        },
        // dedupKey DETERMINISTA (no uuidv7 aleatorio): un retry HTTP del accept NO duplica el match_found.
        dedupKey: `match_found:${match.tripId}:${match.driverId}`,
      });
      await tx.outboxEvent.create({
        data: {
          aggregateId: match.tripId,
          eventType: envelope.eventType,
          envelope: envelope as unknown as Prisma.InputJsonValue,
        },
      });
      return DispatchService.toView({ ...match, outcome: DispatchOutcome.ACCEPTED, respondedAt });
    });

    await this.hotIndex.markBusy(view.driverId);
    // Cierra la sesión de matching (MATCHED) → el advance/reconciler ya no la tocan. Antes: respond() in-process.
    await this.matching.markMatched(view.tripId);
    // BROADCAST EMERGENCY (B5-vert): retira las ofertas HERMANAS vivas (las otras N-1 del broadcast) y avisa
    // a los perdedores. En el flujo STANDARD no hay hermanas (1 OFFERED/viaje) ⇒ no-op. Idempotente.
    await this.retractSiblingOffers(view.tripId, view.id);
    return view;
  }

  /**
   * Retira las ofertas HERMANAS vivas de un viaje tras un accept ganador (broadcast EMERGENCY). El ganador ya
   * cerró la sesión; estas ya no pueden aceptarse (el índice UNIQUE PARCIAL lo impide). Cada una: CAS a
   * TIMEOUT (idempotente — si el sweep o un reject la tomó, count=0 y se salta) + `dispatch.offer_withdrawn`
   * (reason: taken) por outbox, para que la app del conductor retire la tarjeta. STANDARD: sin hermanas, no-op.
   */
  private async retractSiblingOffers(tripId: string, winnerMatchId: string): Promise<void> {
    const siblings = await this.prisma.read.dispatchMatch.findMany({
      where: { tripId, outcome: DispatchOutcome.OFFERED, id: { not: winnerMatchId } },
      select: { id: true, driverId: true },
    });
    for (const sib of siblings) {
      await this.prisma.write.$transaction(async (tx) => {
        const claimed = await tx.dispatchMatch.updateMany({
          where: { id: sib.id, outcome: DispatchOutcome.OFFERED },
          data: { outcome: DispatchOutcome.TIMEOUT, respondedAt: new Date() },
        });
        if (claimed.count === 0) return; // el sweep / un reject concurrente ya la cerró
        const envelope = createEnvelope({
          eventType: 'dispatch.offer_withdrawn',
          producer: 'dispatch-service',
          payload: { tripId, driverId: sib.driverId, reason: 'taken' },
          dedupKey: `offer_withdrawn:${tripId}:${sib.driverId}`,
        });
        await tx.outboxEvent.create({
          data: {
            aggregateId: tripId,
            eventType: envelope.eventType,
            envelope: envelope as unknown as Prisma.InputJsonValue,
          },
        });
      });
    }
  }

  async reject(matchId: string, driverId: string): Promise<MatchView> {
    const view = await this.prisma.write.$transaction(async (tx) => {
      const match = await tx.dispatchMatch.findUnique({ where: { id: matchId } });
      // Ownership-check (anti-IDOR #9): 404 si no existe o no es del conductor firmado (NO filtra existencia).
      if (match?.driverId !== driverId) throw new NotFoundError('Oferta no encontrada');
      const respondedAt = new Date();
      // CAS con driverId en el WHERE (defensa en profundidad). count===0 = el DUEÑO llega tarde → 409.
      const claimed = await tx.dispatchMatch.updateMany({
        where: { id: matchId, driverId, outcome: DispatchOutcome.OFFERED },
        data: { outcome: DispatchOutcome.REJECTED, respondedAt },
      });
      if (claimed.count === 0) {
        throw new ConflictError('La oferta ya fue respondida o expiró', { outcome: match.outcome });
      }
      return DispatchService.toView({ ...match, outcome: DispatchOutcome.REJECTED, respondedAt });
    });

    // Avanza el matching al siguiente candidato por ESTADO (no por una señal in-process). Antes: respond().
    await this.matching.offerNext(view.tripId);
    return view;
  }

  async getMatch(matchId: string, driverId: string): Promise<MatchView> {
    const match = await this.prisma.read.dispatchMatch.findUnique({ where: { id: matchId } });
    // Ownership-check (anti-IDOR #9): 404 si no existe o no es del conductor firmado (NO 403: no filtra
    // existencia, un conductor no puede sondear matchIds ajenos por la diferencia de status code).
    if (match?.driverId !== driverId) throw new NotFoundError('Match no encontrado');
    return DispatchService.toView(match);
  }

  /**
   * Ingestión de un ping de ubicación (consumido de driver.location_updated). `vehicleType` refleja
   * la clase de vehículo activa del conductor y se persiste en el hot index para filtrar el matching.
   * OBLIGATORIA (ADR 013 · Lote D): el default legacy vive en el borde Kafka, no acá.
   */
  async ingestLocation(
    driverId: string,
    point: LatLon,
    vehicleType: VehicleClass,
    attrs?: DriverVehicleAttrs,
  ): Promise<void> {
    await this.hotIndex.upsertLocation(driverId, point, vehicleType, attrs);
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

  /**
   * Tras un TERMINAL del viaje (completado/cancelado/expirado/fallido) el conductor vuelve al pool
   * disponible. A2/B2 (ADR-021 Fase A): además de `markAvailable` (busy-flag) suelta el CLAIM SÍNCRONO
   * per-conductor (`releaseClaim`) — son GEMELOS del accept (`markBusy` + `tryClaimDriver`) y se sueltan
   * JUNTOS. Idempotente + fail-safe: soltar un conductor no-ocupado/no-reclamado es no-op, nunca crashea.
   */
  async releaseDriver(driverId: string): Promise<void> {
    await this.hotIndex.markAvailable(driverId);
    await this.hotIndex.releaseClaim(driverId);
  }

  /**
   * Fase B (ADR-021 · B-react) — el conductor pasó a OFFLINE (`driver.went_offline`): lo EVICTAMOS del pool.
   * `hotIndex.remove` es la semántica correcta para offline (NO `releaseDriver`/`markAvailable`, que lo
   * RE-INSERTARÍA en el set disponible mientras su loc TTL no venza → seguiría siendo candidato de matching
   * estando offline). `remove` borra loc + set de celda + busy-flag + claim per-conductor + índice de
   * presencia en UNA pasada. Idempotente + fail-safe: evictar a un conductor ausente es no-op.
   */
  async evictDriver(driverId: string): Promise<void> {
    await this.hotIndex.remove(driverId);
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
