/**
 * Lote C1 — WaypointProposalService: PARADA mid-trip NEGOCIADA.
 *
 * El pasajero propone agregar una parada DURANTE el viaje (IN_PROGRESS). El server calcula la ruta
 * nueva (waypoints actuales + la parada) y el DELTA de tarifa, y crea una PROPUESTA con TTL. El
 * conductor la acepta (en UNA transacción ACID: se agrega el waypoint al Trip, se estampa la tarifa
 * nueva, se recalcula la polyline y se marca la propuesta ACCEPTED) o la rechaza. Un sweeper expira las
 * que nadie respondió pasado el TTL.
 *
 * Por qué un SERVICE APARTE y no más métodos en TripsService: TripsService ya supera las 1400 líneas y
 * orquesta TODO el ciclo de vida del viaje. La parada negociada es un sub-dominio cohesivo (propose /
 * respond / expire) con su propio agregado (TripWaypointProposal), su propia máquina de estados y su
 * propio sweeper. SRP: aislarlo mantiene ambos services legibles y testeables por separado.
 *
 * Reglas DURAS aplicadas: estados/eventos TIPADOS (§4-ter, cero strings mágicos); dinero en céntimos
 * enteros; transacción ACID para accept (monolito-1-DB, sin saga); idempotencia; errores tipados;
 * server-authoritative (el pasajero NO fija la tarifa — el server calcula el delta y lo estampa al
 * aceptar). El cálculo del delta y la transición de estado viven en el dominio puro (domain/waypoint-proposal).
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConflictError,
  NotFoundError,
  parseOrThrow,
  geoPointSchema,
  type LatLon,
} from '@veo/utils';
import { PricingMode, TripStatus } from '@veo/shared-types';
import type { MapsClient } from '@veo/maps';
import { PrismaService } from '../infra/prisma.service';
import { MAPS_CLIENT } from '../ports/maps/maps.module';
import { Prisma, type Trip, type TripWaypointProposal } from '../generated/prisma';
import type { Env } from '../config/env.schema';
import { applyOfferingPricing, calculateFare, calculateOfferingFare } from './domain/fare';
import { resolveTripOffering } from './domain/offering';
import { EnergyCatalogService } from '../pricing/energy-catalog.service';
import { FuelSurchargeService } from '../pricing/fuel-surcharge.service';
import { resolveAuthoritativeEnergy } from '../pricing/energy-requirements';
import { WaypointProposalStatus, computeFareDelta, isExpired } from './domain/waypoint-proposal';
import { readWaypoints } from './trip-view.mapper';
import { MAX_WAYPOINTS } from './dto/trip.dto';
import {
  emitWaypointProposed,
  emitWaypointAccepted,
  emitWaypointRejected,
  emitWaypointExpired,
  type WaypointProposalEventData,
} from './trip-events';
import {
  WaypointProposalActiveError,
  WaypointLimitReachedError,
  WaypointProposalNotPendingError,
} from './trips.errors';

/** TTL por defecto (segundos) de una propuesta si no se inyecta ConfigService (tests unitarios). */
const DEFAULT_WAYPOINT_PROPOSAL_TTL_SEC = 30;

/** Estados del viaje DESDE los que se puede proponer una parada mid-trip: solo EN CURSO (onboard). */
const WAYPOINT_PROPOSABLE: ReadonlySet<TripStatus> = new Set([TripStatus.IN_PROGRESS]);

/** Resultado de proponer una parada (lo que el BFF/UI necesita para mostrar la confirmación). */
export interface ProposeWaypointResult {
  proposalId: string;
  deltaFareCents: number;
  newFareCents: number;
  newEtaSeconds: number;
  expiresAt: string;
}

/** Resultado de responder una propuesta (estado final + tarifa vigente del viaje). */
export interface RespondWaypointResult {
  proposalId: string;
  status: WaypointProposalStatus;
  fareCents: number;
}

@Injectable()
export class WaypointProposalService {
  private readonly logger = new Logger(WaypointProposalService.name);
  private readonly ttlSeconds: number;
  private readonly energyModelEnabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MAPS_CLIENT) private readonly maps: MapsClient,
    @Optional() config?: ConfigService<Env, true>,
    // F2.1b · catálogo de energía para el re-quote autoritativo bajo el flip. @Optional: tests legacy
    // construyen sin él (flip OFF → política vieja, como en producción pre-flip).
    @Optional() private readonly energyCatalog?: EnergyCatalogService,
    // F2.1b · recargo de combustible (B3) para plegarlo en el re-quote flip-OFF — espejo del create.
    @Optional() private readonly fuel?: FuelSurchargeService,
  ) {
    this.ttlSeconds = config?.get('WAYPOINT_PROPOSAL_TTL_SEC') ?? DEFAULT_WAYPOINT_PROPOSAL_TTL_SEC;
    this.energyModelEnabled = config?.get('PRICING_ENERGY_MODEL_ENABLED') ?? false;
  }

  /** B3 · recargo de combustible por km vigente. Sin servicio (tests) o lectura caída → 0 (degradación honesta). */
  private async resolveFuelPerKmCents(): Promise<number> {
    if (!this.fuel) return 0;
    try {
      return await this.fuel.getPerKmCents();
    } catch {
      return 0;
    }
  }

  // ───────────────────────────── propose ─────────────────────────────

  /**
   * El pasajero PROPONE una parada mid-trip. mustFind + ownership passenger (anti-IDOR) + gate de estado
   * (solo IN_PROGRESS) + cupo (waypoints.length < MAX, la parada nueva cuenta) + sin otra PROPOSED viva.
   * Calcula la ruta nueva (`route(origin, destination, [...waypoints, point])`) y la tarifa nueva con
   * la política de la OFERTA del viaje (ADR 013 §1.7, misma fórmula que FixedDispatchStrategy) →
   * delta = nueva − actual (≥ 0: una parada nunca abarata). Crea la propuesta PROPOSED (expiresAt =
   * now + TTL) + outbox `trip.waypoint_proposed` en la MISMA transacción. Server-authoritative: el
   * delta lo computa el server.
   */
  async proposeWaypoint(
    tripId: string,
    input: { point: LatLon; passengerId?: string },
  ): Promise<ProposeWaypointResult> {
    const trip = await this.mustFindTrip(tripId);
    // A1 · ownership server-side (anti-IDOR): solo el pasajero dueño propone. 404 (no 403) no filtra.
    if (input.passengerId && trip.passengerId !== input.passengerId) {
      throw new NotFoundError('Viaje no encontrado', { id: tripId });
    }
    if (!WAYPOINT_PROPOSABLE.has(trip.status)) {
      throw new ConflictError('Solo se puede proponer una parada con el viaje en curso', {
        status: trip.status,
      });
    }
    const point = parseOrThrow(geoPointSchema, input.point, 'point');

    // Cupo: la parada nueva cuenta para el tope MAX_WAYPOINTS (BR — máximo de paradas por viaje).
    const currentWaypoints = readWaypoints(trip);
    if (currentWaypoints.length >= MAX_WAYPOINTS) {
      throw new WaypointLimitReachedError(MAX_WAYPOINTS);
    }

    // Una sola propuesta ACTIVA por viaje: si ya hay una PROPOSED viva (no vencida), rechazamos con 409
    // (el pasajero espera la respuesta del conductor o el TTL). La elección "rechazar" (vs. expirar la
    // vieja) es la más simple y honesta: no resucitamos rutas/tarifas calculadas con un estado anterior.
    // El índice único parcial en DB es el backstop ante una carrera (dos propose concurrentes).
    const existing = await this.prisma.read.tripWaypointProposal.findFirst({
      where: { tripId, status: WaypointProposalStatus.PROPOSED },
    });
    if (existing && !isExpired(existing.expiresAt, new Date())) {
      throw new WaypointProposalActiveError(existing.id);
    }

    // Ruta NUEVA: la parada se APPENDEA a los waypoints actuales (antes del destino), preservando el orden.
    const origin: LatLon = { lat: trip.originLat, lon: trip.originLon };
    const destination: LatLon = { lat: trip.destLat, lon: trip.destLon };
    const newWaypoints: LatLon[] = [...currentWaypoints, { lat: point.lat, lon: point.lon }];
    const route = await this.maps.route(origin, destination, newWaypoints);

    // ADR 013 §1.7 · el re-quote de la parada valora la ruta NUEVA con la MISMA política de la OFERTA
    // del viaje que la tarifa original: resolvemos la oferta persistida (`Trip.category`; null en
    // viajes pre-catálogo → fallback por `vehicleType`, la MISMA precedencia de createTrip) y
    // aplicamos la fórmula firme compartida con FixedDispatchStrategy (`applyOfferingPricing`:
    // multiplier + mínima — UNA fuente, domain/fare.ts). Sin esto, un viaje FIXED confort/xl recibía
    // un delta NEGATIVO al agregar parada (la ruta nueva se cotizaba a tasa económico-base, por debajo
    // de la tarifa firme ya multiplicada del Lote B) y moto se sobre-cobraba ×1/0.55.
    //
    // PUJA (decisión documentada): la política se aplica TAMBIÉN acá. El re-quote NO es un bid — es un
    // quote server-authoritative que reemplaza la tarifa al aceptar (preview = lo que se cobra), y el
    // ancla que el pasajero vio en su quote original (suggestedCents del BFF) YA incluye el multiplier:
    // cotizar la ruta extendida a tasa económico-base sería el único punto post-Lote-C que ignora el
    // catálogo (moto pagaría tasa auto por la parada). Limitación PRE-existente y ortogonal al
    // multiplier: una tarifa negociada lejos del valor de fórmula hace saltar el delta (la semántica
    // "reemplazar" vs "delta marginal aditivo sobre lo negociado" requiere su propio ADR).
    const { offering } = resolveTripOffering(trip.category, trip.vehicleType);
    const surge = Number(trip.surgeMultiplier.toString());
    // El combustible (B3) se pliega en la rama flip-OFF (espejo del create); en flip-ON la energía
    // pass-through lo reemplaza (calculateOfferingFare ignora fuelPerKmCents).
    const fareInput = {
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      surgeMultiplier: surge,
      childMode: trip.childMode,
      fuelPerKmCents: await this.resolveFuelPerKmCents(),
    };
    // F2.1b · bajo el flip + FIXED la ruta extendida se cotiza con la energía AUTORITATIVA (espejo del
    // create): sin esto el tramo nuevo se cobraba sin energía → cobro-de-menos. PUJA/flip-OFF: política
    // vieja (multiplier + mínima). El piso monótono de abajo (Math.max) sigue cubriendo ambos.
    const policyFare =
      this.energyModelEnabled && trip.dispatchMode === PricingMode.FIXED
        ? calculateOfferingFare(
            fareInput,
            offering.pricing,
            await resolveAuthoritativeEnergy(this.energyCatalog, offering),
          )
        : applyOfferingPricing(calculateFare(fareInput), offering.pricing);
    // Invariante de dominio: agregar una parada NUNCA abarata el viaje (delta ≥ 0). Piso en la tarifa
    // VIGENTE: cubre la puja con bid generoso (no se regala plata reseteando la negociación hacia
    // abajo) y rutas raras del motor. En FIXED es no-op (la fórmula es monótona con la ruta).
    const newFareCents = Math.max(policyFare.cents, trip.fareCents);
    // Delta server-authoritative: tarifa nueva (ruta con la parada) − tarifa actual del viaje. Céntimos.
    const deltaFareCents = computeFareDelta(newFareCents, trip.fareCents);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlSeconds * 1000);

    try {
      const proposal = await this.prisma.write.$transaction(async (tx) => {
        const created = await tx.tripWaypointProposal.create({
          data: {
            tripId,
            lat: point.lat,
            lon: point.lon,
            deltaFareCents,
            newFareCents,
            status: WaypointProposalStatus.PROPOSED,
            proposedAt: now,
            expiresAt,
          },
        });
        const eventData: WaypointProposalEventData = {
          proposalId: created.id,
          tripId,
          passengerId: trip.passengerId,
          driverId: trip.driverId ?? undefined,
          point: { lat: point.lat, lon: point.lon },
          deltaFareCents,
          newFareCents,
        };
        await emitWaypointProposed(tx, eventData, expiresAt);
        return created;
      });

      this.logger.log(
        `waypoint: viaje ${tripId} propuso parada ${proposal.id} ` +
          `(delta ${deltaFareCents}¢, nueva ${newFareCents}¢, TTL ${this.ttlSeconds}s)`,
      );
      return {
        proposalId: proposal.id,
        deltaFareCents,
        newFareCents,
        newEtaSeconds: route.durationSeconds,
        expiresAt: expiresAt.toISOString(),
      };
    } catch (err) {
      // Carrera: el índice único parcial `WHERE status='PROPOSED'` rechaza un segundo PROPOSED concurrente
      // (P2002). Lo traducimos al mismo 409 tipado que el chequeo de lectura (degradación honesta).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const live = await this.prisma.read.tripWaypointProposal.findFirst({
          where: { tripId, status: WaypointProposalStatus.PROPOSED },
        });
        throw new WaypointProposalActiveError(live?.id ?? tripId);
      }
      throw err;
    }
  }

  // ───────────────────────────── respond ─────────────────────────────

  /**
   * El CONDUCTOR responde la propuesta (accept/reject). Ownership driver (anti-IDOR, mismo patrón que
   * accept/start). La propuesta debe estar PROPOSED y NO vencida. ACID:
   *  - accept: en UNA tx → append el waypoint al Trip + Trip.fareCents = newFareCents + recompute
   *    route_polyline/distance/duration + marca la propuesta ACCEPTED (respondedAt) + outbox accepted.
   *  - reject: marca REJECTED (respondedAt) + outbox rejected.
   * IDEMPOTENTE: un guard CAS `where status=PROPOSED` mueve y valida en el mismo statement. Re-responder
   * una propuesta ya resuelta → 409 tipado (WaypointProposalNotPendingError). El viaje debe seguir EN CURSO.
   */
  async respondWaypoint(
    tripId: string,
    proposalId: string,
    input: { driverId?: string; accept: boolean },
  ): Promise<RespondWaypointResult> {
    const trip = await this.mustFindTrip(tripId);
    // A1 · ownership server-side (anti-IDOR): solo el conductor asignado responde SU viaje. 404 no filtra.
    if (input.driverId && trip.driverId !== input.driverId) {
      throw new NotFoundError('Viaje no encontrado', { id: tripId });
    }

    const proposal = await this.prisma.read.tripWaypointProposal.findUnique({
      where: { id: proposalId },
    });
    if (proposal?.tripId !== tripId) {
      throw new NotFoundError('Propuesta de parada no encontrada', { proposalId });
    }
    // Idempotencia: solo PROPOSED es respondible. Una ya resuelta (ACCEPTED/REJECTED/EXPIRED) → 409 claro.
    if (proposal.status !== WaypointProposalStatus.PROPOSED) {
      throw new WaypointProposalNotPendingError(proposal.status);
    }
    // Vencida: el sweeper aún no la barrió, pero el TTL ya pasó → no se puede aceptar/rechazar (se tratará
    // como EXPIRED). 409 honesto: la decisión llegó tarde.
    if (isExpired(proposal.expiresAt, new Date())) {
      throw new WaypointProposalNotPendingError(WaypointProposalStatus.EXPIRED);
    }

    const point = { lat: proposal.lat, lon: proposal.lon };
    const eventData: WaypointProposalEventData = {
      proposalId: proposal.id,
      tripId,
      passengerId: trip.passengerId,
      driverId: trip.driverId ?? undefined,
      point,
      deltaFareCents: proposal.deltaFareCents,
      newFareCents: proposal.newFareCents,
    };

    if (!input.accept) {
      const status = await this.markResolved(
        proposal,
        WaypointProposalStatus.REJECTED,
        async (tx) => {
          await emitWaypointRejected(tx, eventData);
        },
      );
      this.logger.log(`waypoint: viaje ${tripId} RECHAZÓ parada ${proposalId}`);
      return { proposalId, status, fareCents: trip.fareCents };
    }

    // ACCEPT — transacción ACID: viaje (waypoint + tarifa + ruta) + propuesta ACCEPTED + outbox, todo junto.
    // El viaje debe seguir EN CURSO al aceptar (pudo completarse entre propose y respond): guard de estado.
    if (!WAYPOINT_PROPOSABLE.has(trip.status)) {
      throw new ConflictError('El viaje ya no está en curso; no se puede agregar la parada', {
        status: trip.status,
      });
    }

    // Recompute server-authoritative de la ruta con la parada appendeada (no confiamos en snapshots viejos
    // de distancia/duración; la tarifa estampada es proposal.newFareCents, fijada server-side al proponer).
    const origin: LatLon = { lat: trip.originLat, lon: trip.originLon };
    const destination: LatLon = { lat: trip.destLat, lon: trip.destLon };
    const newWaypoints: LatLon[] = [...readWaypoints(trip), point];
    const route = await this.maps.route(origin, destination, newWaypoints);
    const waypointsJson = newWaypoints.map((w) => ({ lat: w.lat, lon: w.lon }));

    const applied = await this.prisma.write.$transaction(async (tx) => {
      // Guard CAS de la propuesta: solo si SIGUE PROPOSED (no doble accept ni pisar un expire/reject).
      const moved = await tx.tripWaypointProposal.updateMany({
        where: { id: proposalId, status: WaypointProposalStatus.PROPOSED },
        data: { status: WaypointProposalStatus.ACCEPTED, respondedAt: new Date() },
      });
      if (moved.count === 0) return false; // otro actor ganó la carrera (doble-accept/expire/reject)

      // CAS de ESTADO DEL VIAJE: solo pisa la tarifa si el viaje SIGUE en curso. El gate de estado (319) se
      // chequeó sobre una lectura previa al `maps.route` (cientos de ms); una carrera que terminó el viaje
      // (cancel del pasajero, watchdog, redelivery/multi-device) en esa ventana → count 0 → throw DENTRO de la
      // tx, que REVIERTE el CAS de la propuesta (atómico). Evita la mutación financiera post-completion (mismo
      // invariante que el CAS de changeDestination).
      const tripMoved = await tx.trip.updateMany({
        where: { id: tripId, status: { in: [...WAYPOINT_PROPOSABLE] } },
        data: {
          waypoints: waypointsJson,
          fareCents: proposal.newFareCents,
          distanceMeters: route.distanceMeters,
          durationSeconds: route.durationSeconds,
          routePolyline: route.polyline || null,
        },
      });
      if (tripMoved.count === 0) {
        throw new ConflictError('El viaje ya no está en curso; no se puede aplicar la parada', {
          tripId,
        });
      }
      await emitWaypointAccepted(tx, eventData);
      return true;
    });

    if (!applied) {
      // Carrera perdida: releemos el estado actual y devolvemos un 409 honesto (idempotente).
      const fresh = await this.prisma.read.tripWaypointProposal.findUnique({
        where: { id: proposalId },
      });
      throw new WaypointProposalNotPendingError(fresh?.status ?? WaypointProposalStatus.EXPIRED);
    }

    this.logger.log(
      `waypoint: viaje ${tripId} ACEPTÓ parada ${proposalId} ` +
        `(tarifa ${trip.fareCents}¢ → ${proposal.newFareCents}¢)`,
    );
    return {
      proposalId,
      status: WaypointProposalStatus.ACCEPTED,
      fareCents: proposal.newFareCents,
    };
  }

  // ───────────────────────────── timeout / sweeper ─────────────────────────────

  /**
   * Selecciona propuestas PROPOSED con `expiresAt` vencido (candidatas a EXPIRED). PRE-FILTRO barato para
   * el sweeper: devuelve snapshot mínimo + el passengerId del viaje (para el push). Acotado por `limit`.
   */
  async findExpiredCandidates(
    now: Date,
    limit: number,
  ): Promise<
    (Pick<TripWaypointProposal, 'id' | 'tripId' | 'lat' | 'lon'> & { passengerId: string })[]
  > {
    const rows = await this.prisma.read.tripWaypointProposal.findMany({
      where: { status: WaypointProposalStatus.PROPOSED, expiresAt: { lte: now } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
      select: {
        id: true,
        tripId: true,
        lat: true,
        lon: true,
        trip: { select: { passengerId: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      tripId: r.tripId,
      lat: r.lat,
      lon: r.lon,
      passengerId: r.trip.passengerId,
    }));
  }

  /**
   * Expira UNA propuesta vencida: PROPOSED → EXPIRED + outbox `trip.waypoint_expired` en UNA transacción.
   * IDEMPOTENTE y seguro ante carreras: guard CAS `where status=PROPOSED AND expiresAt<=now`. Si otro
   * actor (respond/otro tick) ya la movió (count 0) → no-op. Devuelve true si la expiró, false si no.
   */
  async expireProposal(proposalId: string, now: Date = new Date()): Promise<boolean> {
    const proposal = await this.prisma.read.tripWaypointProposal.findUnique({
      where: { id: proposalId },
      include: { trip: { select: { passengerId: true } } },
    });
    if (proposal?.status !== WaypointProposalStatus.PROPOSED) return false;
    if (!isExpired(proposal.expiresAt, now)) return false;

    const applied = await this.prisma.write.$transaction(async (tx) => {
      const moved = await tx.tripWaypointProposal.updateMany({
        where: {
          id: proposalId,
          status: WaypointProposalStatus.PROPOSED,
          expiresAt: { lte: now },
        },
        data: { status: WaypointProposalStatus.EXPIRED, respondedAt: now },
      });
      if (moved.count === 0) return false;
      await emitWaypointExpired(tx, {
        proposalId: proposal.id,
        tripId: proposal.tripId,
        passengerId: proposal.trip.passengerId,
        point: { lat: proposal.lat, lon: proposal.lon },
      });
      return true;
    });

    if (applied) {
      this.logger.log(`waypoint: propuesta ${proposalId} EXPIRED (TTL vencido)`);
    }
    return applied;
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private async mustFindTrip(id: string): Promise<Trip> {
    const trip = await this.prisma.write.trip.findUnique({ where: { id } });
    if (!trip) throw new NotFoundError('Viaje no encontrado', { id });
    return trip;
  }

  /** Marca una propuesta a un terminal (reject) con guard CAS + un emisor de evento, en UNA transacción. */
  private async markResolved(
    proposal: TripWaypointProposal,
    target: typeof WaypointProposalStatus.REJECTED,
    emit: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<WaypointProposalStatus> {
    const applied = await this.prisma.write.$transaction(async (tx) => {
      const moved = await tx.tripWaypointProposal.updateMany({
        where: { id: proposal.id, status: WaypointProposalStatus.PROPOSED },
        data: { status: target, respondedAt: new Date() },
      });
      if (moved.count === 0) return false;
      await emit(tx);
      return true;
    });
    if (!applied) {
      const fresh = await this.prisma.read.tripWaypointProposal.findUnique({
        where: { id: proposal.id },
      });
      throw new WaypointProposalNotPendingError(fresh?.status ?? WaypointProposalStatus.EXPIRED);
    }
    return target;
  }
}
