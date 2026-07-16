/**
 * OfferBoardService — núcleo de la PUJA (negociación pasajero↔conductor, ADR 010 §1–§3, §5, §6).
 *
 * dispatch es el dueño de la negociación EFÍMERA: abre un board por viaje al recibir `trip.bid_posted`,
 * hace broadcast del bid a los conductores ELEGIBLES cercanos (reutiliza el hot-index + el mecanismo de
 * entrega de ofertas `dispatch.offered`), colecta las ofertas de los conductores (accept/counter) tras
 * pasar el GATE de elegibilidad, y al elegir el pasajero UNA oferta cierra el board y emite el match.
 *
 * Máquina del board (§3.2):  OPEN → CLOSED_MATCHED | EXPIRED | CANCELLED.
 * Máquina de la oferta (§3.3): PENDING → ACCEPTED (las demás LAPSED) | LAPSED | WITHDRAWN | STALE.
 *
 * Todos los emits van por OUTBOX-en-transacción (FOUNDATION §6, regla #3), idempotentes. El board y las
 * ofertas son idempotentes por (tripId) / (tripId, driverId).
 *
 * COORDINACIÓN (Lote B): trip-service emitirá `trip.bid_posted` en el Lote C. Acá el board consume ese
 * evento en aislamiento; el viejo camino `trip.requested`→matching auto-secuencial sigue intacto.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  toH3,
  neighbors,
  uuidv7,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  DISPATCH_H3_RESOLUTION,
  BID_MAX_CENTS,
  type LatLon,
} from '@veo/utils';
import { createEnvelope, OFFER_WITHDRAWN_REASON } from '@veo/events';
// Finding #4 (§5-bis DRY / §4-ter cero literales sueltos): la detección de violación de UNIQUE vive UNA
// sola vez en @veo/database (helper tipado + constante PRISMA_UNIQUE_VIOLATION), compartida con
// payment-service. Reusamos ESE helper en vez de duplicar inline el literal 'P2002' y el `instanceof`
// (que, además, es FRÁGIL: cada servicio genera su propio cliente Prisma → clases distintas; el helper
// compartido detecta de forma ESTRUCTURAL por name+code, válido cross-cliente).
import { isUniqueViolation } from '@veo/database';
import {
  DispatchOutcome,
  findOffering,
  hasRequiredCertifications,
  isVehicleEligibleForOffering,
  type OfferingRequirements,
  type SpecialRequest,
  type VehicleClass,
} from '@veo/shared-types';
import type { MapsClient } from '@veo/maps';
import { domainEventsTotal, BusinessEventResult } from '@veo/observability';
import { Prisma } from '../generated/prisma';
import { OFFER_BOARD_REPO, type OfferBoardRepository } from './offer-board.repository';
import { HOT_INDEX, type HotIndex, type DriverLocation } from '../hot-index/hot-index.port';
import { DriverPool } from './driver-pool';
import { MAPS_CLIENT } from '../ports/maps/maps.module';
import { OFFER_DELIVERY, type OfferDelivery } from './offer-delivery.port';
import {
  OFFER_BOARD_STORE,
  BoardStatus,
  OfferStatus,
  OfferKind,
  ClientBoardStatus,
  bidFieldsFromBoard,
  type Offer,
  type OfferBoard,
  type OfferBoardStore,
  type OffersView,
} from './offer-board.port';
import { EligibilityGate } from './eligibility.gate';
import { DispatchRadiusConfigService } from './dispatch-radius-config.service';
import { radiusKmToKRing } from './dispatch-policy';
import type { Env } from '../config/env.schema';

export interface BidPosted {
  tripId: string;
  passengerId: string;
  bidCents: number;
  vehicleType: VehicleClass;
  /// B5-3 — oferta/tier del viaje (offeringId): el board la guarda para derivar `requires` y enforcar la
  /// eligibilidad por TIER en PUJA igual que FIXED. Opcional por compat N-2 (bid_posted previos sin él).
  category?: string;
  origin: LatLon;
  /// Destino + distancia/duración del viaje (del row Trip vía `trip.bid_posted`): el board los guarda para
  /// que el conductor VEA pickup→destino + distancia en la tarjeta de puja. El destino se ENGROSA a ~111m
  /// antes de exponerlo a los conductores no asignados (`coarsenPreBid`); distancia/duración pasan directo.
  destination: LatLon;
  distanceMeters: number;
  durationSeconds: number;
  /// ADVISORY (ADR-019 Lote A). La ventana la decide dispatch (config editable por el admin,
  /// `getWindows().bidWindowSec`): TANTO openBoard (bid inicial) COMO reopenBoard (re-match) usan ese valor
  /// de runtime. Este campo lo sigue enviando el productor (trip-service) por compat N-2 del contrato, pero
  /// dispatch lo IGNORA para la ventana; ripearlo del productor es follow-up.
  windowSec: number;
  /// H13 — ciclo de negociación del viaje (lo guardamos en el board y lo estampamos en offer_accepted).
  negotiationSeq: number;
  /// BE-2 — solicitudes especiales del pasajero (mascota/equipaje/silla); el conductor las ve en el board.
  /// Opcional en la ENTRADA (default [] en openBoard) por compat N-2 con bid_posted previos.
  specialRequests?: SpecialRequest[];
  /// Ola 2B — paradas intermedias del viaje (máx 3, del evento). El board persiste SOLO el CONTEO
  /// (minimización de datos: las coordenadas de paradas no cruzan a conductores no asignados).
  /// Opcional por compat N-2 con bid_posted previos sin el campo.
  waypoints?: LatLon[];
}

export interface Reassigning {
  tripId: string;
  /// Conductor que canceló (se libera del hot-index para que vuelva a ser elegible).
  driverId: string;
  passengerId: string;
  vehicleType: VehicleClass;
  /// B5-3 — oferta/tier del viaje: el board re-abierto la re-persiste para enforcar el TIER en el re-match.
  /// Opcional por compat N-2 (reassigning previos sin él).
  category?: string;
  origin: LatLon;
  /// Destino + distancia/duración del viaje: el board re-abierto los conserva para que el conductor del
  /// re-match VEA pickup→destino + distancia igual que en la puja original (trip.reassigning ya los transporta).
  destination: LatLon;
  distanceMeters: number;
  durationSeconds: number;
  /// BE-2 — solicitudes especiales del pasajero: el board re-abierto las conserva aunque se rearme SOLO
  /// desde el evento (el row Trip fresco viaja en trip.reassigning). Opcional por compat N-2 (reassigning
  /// previos sin el campo ⇒ [] si el board previo tampoco sobrevivió).
  specialRequests?: SpecialRequest[];
  /// Ola 2B — paradas del viaje (máx 3, row Trip FRESCO al momento del cancel). El board re-abierto
  /// persiste SOLO el conteo (need-to-know pre-aceptación). Opcional por compat N-2.
  waypoints?: LatLon[];
  bidCents: number;
  /// H13 — ciclo de negociación del NUEVO re-match (seq incrementado por trip al pasar a REASSIGNING).
  negotiationSeq: number;
}

export interface SubmitOfferInput {
  driverId: string;
  tripId: string;
  kind: OfferKind;
  priceCents: number;
}

/**
 * Una puja OPEN cercana enriquecida PER-CONDUCTOR: el board (dato del viaje, igual para todos) + el
 * `pickupEtaSeconds` conductor→origen (dato del PAR conductor-board, calculado en el poll con la
 * ubicación viva del hot-index). 0 = ETA no disponible (maps caído): el DTO lo omite río abajo.
 */
export interface NearbyOpenBid {
  board: OfferBoard;
  pickupEtaSeconds: number;
}

/**
 * §4-ter — prefijos de dedupKey CENTRALIZADOS (cero magic strings repetidos). El VALOR resultante de
 * cada clave es EXACTAMENTE el de antes (los tests asertan `match_found:${tripId}:${driverId}`, etc.):
 * estos helpers solo DRY-ean la construcción, no cambian el formato. Cualquier cambio de formato pasa por
 * acá una sola vez (la dedupKey va al envelope Y a la columna OutboxEvent.dedupKey — deben coincidir).
 */
const DEDUP_PREFIX = {
  OFFER_ACCEPTED: 'offer_accepted',
  MATCH_FOUND: 'match_found',
  OFFER_MADE: 'offer_made',
  NO_OFFERS: 'no_offers',
  OFFER_WITHDRAWN: 'offer_withdrawn',
  BID_CANCELLED: 'bid_cancelled',
} as const;

const dedupOfferAccepted = (tripId: string, driverId: string): string =>
  `${DEDUP_PREFIX.OFFER_ACCEPTED}:${tripId}:${driverId}`;
const dedupMatchFound = (tripId: string, driverId: string): string =>
  `${DEDUP_PREFIX.MATCH_FOUND}:${tripId}:${driverId}`;
const dedupOfferMade = (
  tripId: string,
  driverId: string,
  kind: OfferKind,
  priceCents: number,
): string => `${DEDUP_PREFIX.OFFER_MADE}:${tripId}:${driverId}:${kind}:${priceCents}`;
const dedupNoOffers = (tripId: string, windowEpoch: string): string =>
  `${DEDUP_PREFIX.NO_OFFERS}:${tripId}:${windowEpoch}`;
// Cycle-aware (ADR-020 Lote 2 follow-up): incluye el `negotiationSeq` (H13, monotónico por ciclo, no
// resetea en re-bid) para que un offer_withdrawn de un CICLO no deduplique el del ciclo SIGUIENTE del
// MISMO (trip, driver). Sin el seq, un conductor que oferta y ve expirar el board en re-bids sucesivos
// del mismo viaje solo recibiría el PRIMER bid:closed → su "esperando" quedaría stale del 2º en adelante.
const dedupOfferWithdrawn = (tripId: string, driverId: string, cycle: string | number): string =>
  `${DEDUP_PREFIX.OFFER_WITHDRAWN}:${tripId}:${driverId}:${cycle}`;
const dedupBidCancelled = (tripId: string): string => `${DEDUP_PREFIX.BID_CANCELLED}:${tripId}`;

/**
 * Finding #4a — el re-insert de la MISMA dedupKey estable (reconcile/retry tras crash) debe tragarse
 * como NO-OP idempotente, NUNCA burbujear como error: el evento YA está encolado. El check vive en
 * `isUniqueViolation` (@veo/database, importado arriba): un solo lugar para todo el monorepo.
 */
@Injectable()
export class OfferBoardService {
  private readonly logger = new Logger(OfferBoardService.name);
  /**
   * Techo de la contraoferta en céntimos PEN (guardarraíl anti-abuso/anti-overflow int4). Un COUNTER
   * se vuelve el fareCents del viaje si el pasajero lo acepta, así que tampoco puede superarlo.
   */
  private readonly bidMaxCents: number;
  /** Margen (s) sobre la ventana para el TTL de Redis, así el barrido alcanza a marcar EXPIRED. */
  private static readonly TTL_MARGIN_SECONDS = 30;
  /**
   * A2 (ADR-021 Fase A) — TTL (s) de la RED DE SEGURIDAD del claim síncrono per-conductor. GEMELO del
   * BUSY_TTL del hot-index (2h): el claim y el busy-flag se ponen JUNTOS en el accept (`tryClaimDriver` +
   * `markBusy`) y se sueltan JUNTOS en el terminal (`releaseDriver` → `releaseClaim` + `markAvailable`).
   * El release explícito es el camino normal; el TTL solo cubre el crash entre el accept y el terminal, y
   * es largo para no expirar a MITAD de un viaje vivo (dejaría al conductor reclamable durante su viaje).
   */
  private static readonly DRIVER_CLAIM_TTL_SECONDS = 7_200;

  constructor(
    @Inject(OFFER_BOARD_REPO) private readonly repo: OfferBoardRepository,
    @Inject(OFFER_BOARD_STORE) private readonly store: OfferBoardStore,
    @Inject(HOT_INDEX) private readonly hotIndex: HotIndex,
    private readonly driverPool: DriverPool,
    @Inject(MAPS_CLIENT) private readonly maps: MapsClient,
    @Inject(OFFER_DELIVERY) private readonly offerDelivery: OfferDelivery,
    private readonly eligibility: EligibilityGate,
    // Radio de broadcast de pujas EDITABLE en runtime por el admin (config singleton, cacheado). La
    // fuente VIVA del k-ring es este service; DISPATCH_MAX_K_RING queda como default de la config (schema).
    private readonly radiusConfig: DispatchRadiusConfigService,
    config: ConfigService<Env, true>,
  ) {
    // Techo de la contraoferta: del env (ajustable por entorno) con fallback al canónico de @veo/utils.
    this.bidMaxCents = config.get<number>('BID_MAX_CENTS') ?? BID_MAX_CENTS;
  }

  // ── Apertura del board: consume trip.bid_posted ──────────────────────────────────────────────

  /** Abre un board OPEN para el viaje y hace broadcast del bid a los conductores elegibles cercanos. */
  async openBoard(bid: BidPosted): Promise<void> {
    // ADR-019 Lote A — la ventana de la puja es AUTORIDAD de dispatch (config editable por el admin,
    // cacheada), NO la del productor: `bid.windowSec` (trip-service) es ADVISORY. openBoard y reopenBoard
    // usan el MISMO valor de runtime, así el board inicial y el re-match honran lo que el dueño fija.
    const { bidWindowSec } = await this.radiusConfig.getWindows();
    const expiresAt = Date.now() + bidWindowSec * 1000;
    const board: OfferBoard = {
      tripId: bid.tripId,
      passengerId: bid.passengerId,
      bidCents: bid.bidCents,
      vehicleType: bid.vehicleType,
      // B5-3 — el tier del viaje viaja al board: el gate deriva `requires` de acá para enforcar la
      // elegibilidad en PUJA (un tier inferior no puede ganar un bid de tier superior).
      category: bid.category,
      origin: bid.origin,
      // Destino + distancia/duración del viaje: el board los guarda para que el conductor pinte pickup→destino
      // + distancia. El destino se engrosa a ~111m recién al DERIVAR los campos de puja (bidFieldsFromBoard);
      // acá se persiste el exacto (need-to-know del conductor ASIGNADO, que lo obtiene por /route al match).
      destination: bid.destination,
      distanceMeters: bid.distanceMeters,
      durationSeconds: bid.durationSeconds,
      // A3 — celda H3 del origen calculada UNA vez acá: alimenta el índice inverso `board:cell:<cell>`
      // que `listOpenBidsNear` consulta por k-ring (en vez de cargar TODOS los boards y filtrar en Node).
      originCell: toH3(bid.origin, DISPATCH_H3_RESOLUTION),
      status: BoardStatus.OPEN,
      expiresAt,
      // H13 — sella el ciclo de negociación en el board; se estampa en offer_accepted al aceptar.
      negotiationSeq: bid.negotiationSeq,
      // BE-2 — el conductor las ve al listar boards abiertos (/bids/open).
      specialRequests: bid.specialRequests ?? [],
      // Ola 2B — solo el CONTEO de paradas (need-to-know pre-aceptación); el ganador obtiene la ruta por /route.
      waypointCount: bid.waypoints?.length ?? 0,
    };
    // N8 — Higiene de ventana (espejo de reopenBoard): PURGA las ofertas de cualquier ventana anterior
    // ANTES de abrir. Un `trip.bid_posted` puede ser un RE-BID (el pasajero subió el bid tras un
    // REASSIGNING/EXPIRED): sin este clear, ofertas PENDING a un precio VIEJO/bajo de la ventana previa
    // sobreviven en el HASH y el pasajero podría aceptar una oferta rancia barata. Tras el clear, el
    // `bidCents` recién abierto es la ÚNICA referencia de precio.
    await this.store.clearOffers(bid.tripId);
    await this.store.saveBoard(board, bidWindowSec + OfferBoardService.TTL_MARGIN_SECONDS);
    this.logger.log(
      `board abierto trip=${bid.tripId} bid=${bid.bidCents} ` +
        `window=${bidWindowSec}s (autoridad admin; bid.windowSec=${bid.windowSec}s advisory)`,
    );
    await this.broadcast(board);
  }

  /**
   * Consume trip.reassigning (robustez #4): RECONSTRUYE el board y lo re-abre al bidCents del evento.
   * OJO (H6.4): la reasignación AUTOMÁTICA tras cancel del conductor re-abre al MISMO bid VIEJO
   * (`fareCents` actual del viaje) — NO sube solo. La SUBIDA del precio es una acción explícita del
   * pasajero (`POST /trips/:id/rebid` → trip-service emite `trip.bid_posted` → openBoard con board fresco
   * al nuevo bid), no este camino. El conductor puede cancelar MINUTOS después de aceptar, cuando la key
   * del board YA EXPIRÓ por TTL (~90s) — por eso NO dependemos del board previo de Redis: el evento viene
   * ENRIQUECIDO (passengerId/vehicleType/origin/bidCents) y reconstruimos un board OPEN fresco desde cero.
   * Si existe un board previo, lo sobreescribimos igual (idempotente). SIEMPRE abrimos y difundimos.
   */
  async reopenBoard(reassign: Reassigning): Promise<void> {
    // D1 (ADR-019) — ventana del re-match leída EN RUNTIME (config editable por el admin, cacheada), NO
    // hardcodeada a 60s. Así reopenBoard honra el valor que el dueño fija en el panel, sin restart.
    const { bidWindowSec } = await this.radiusConfig.getWindows();
    // Reconstrucción autosuficiente: si quedaba metadato del board previo lo reusamos, pero el caso
    // canónico (board ya expirado por TTL) se rearma SOLO con el payload del evento.
    const existing = await this.store.getBoard(reassign.tripId);
    const origin = existing?.origin ?? reassign.origin;
    const reopened: OfferBoard = {
      tripId: reassign.tripId,
      passengerId: existing?.passengerId ?? reassign.passengerId,
      vehicleType: existing?.vehicleType ?? reassign.vehicleType,
      // B5-3 — preserva el tier del board previo si sobrevivió (TTL no expiró); si se rearma SOLO desde el
      // evento (board ya expirado), lo toma del payload ENRIQUECIDO de trip.reassigning. Así el board
      // re-abierto NUNCA pierde sus `requires` y el re-match enforça el TIER igual que la puja original.
      category: existing?.category ?? reassign.category,
      origin,
      // Destino + distancia/duración: se preservan del board previo si sobrevivió (TTL no expiró); si se rearma
      // SOLO desde el evento (board ya expirado), los toma del payload ENRIQUECIDO de trip.reassigning. Así el
      // board re-abierto NUNCA pierde el destino y el conductor del re-match ve pickup→destino igual que la puja
      // original (a diferencia de specialRequests, reassigning SÍ transporta estos campos → sin degradación a []).
      destination: existing?.destination ?? reassign.destination,
      distanceMeters: existing?.distanceMeters ?? reassign.distanceMeters,
      durationSeconds: existing?.durationSeconds ?? reassign.durationSeconds,
      // A3 — re-deriva la celda del origen resuelto (reusa la del board previo si existía, o la del evento).
      originCell: existing?.originCell ?? toH3(origin, DISPATCH_H3_RESOLUTION),
      bidCents: reassign.bidCents,
      status: BoardStatus.OPEN,
      // Ventana fresca (config del admin, `bidWindowSec`) al MISMO bid (la subida va por rebid → bid_posted).
      expiresAt: Date.now() + bidWindowSec * 1000,
      // H13 — el seq SIEMPRE viene del EVENTO (el nuevo ciclo de la reasignación), NUNCA del board previo:
      // re-abrir = ciclo fresco, así el offer_accepted del re-match lleva un seq MAYOR y el offer_accepted
      // STALE del ciclo anterior queda bloqueado en applyAgreedFare (seq menor → where no matchea).
      negotiationSeq: reassign.negotiationSeq,
      // BE-2 — del EVENTO primero (row Trip FRESCO al momento del cancel; cierra el follow-up "reassigning
      // no las transportaba" que degradaba a [] con el board expirado); el board previo queda como compat
      // N-2 para un reassigning viejo sin el campo. A diferencia de destination/category (inmutables entre
      // bid y cancel), acá el evento puede ser MÁS fresco que el board.
      specialRequests: reassign.specialRequests ?? existing?.specialRequests ?? [],
      // Ola 2B — mismo criterio: el conteo del EVENTO (incluye una parada aceptada POST-accept que el board
      // original no vio); board previo como compat N-2 de un evento viejo sin el campo. Antes degradaba a 0.
      waypointCount: reassign.waypoints ? reassign.waypoints.length : (existing?.waypointCount ?? 0),
    };
    // N4 — Higiene de ventana: PURGA las ofertas de la ventana ANTERIOR antes de re-abrir. Sin esto, un
    // COUNTER viejo (a un precio que ya no aplica) o una oferta STALE/LAPSED sobreviven en el HASH y el
    // pasajero podría aceptar un precio rancio de la ventana cerrada. Tras el clear, el bidCents re-abierto
    // es la ÚNICA referencia de precio y no hay ofertas de la ventana previa que mal-aceptar.
    await this.store.clearOffers(reassign.tripId);
    await this.store.saveBoard(reopened, bidWindowSec + OfferBoardService.TTL_MARGIN_SECONDS);
    this.logger.log(
      `board ${existing ? 're-abierto' : 'reconstruido'} trip=${reassign.tripId} bid=${reassign.bidCents}`,
    );
    await this.broadcast(reopened);
  }

  /**
   * Radio (k-ring) del broadcast de PUJA vigente. FEATURE-FLAG dispatch-policy-v2: v2 → radiusKmToKRing(
   * broadcastRadiusKm) de la política (razona en km); v1 (default, o policyV2 malformado) → matchKRing de
   * la config de radios (comportamiento actual VERBATIM). Lo comparten `broadcast` y `listOpenBidsNear`
   * para que el conductor VEA en su poll exactamente los boards que se le difunden (paridad de radio).
   */
  private async resolveBroadcastKRing(): Promise<number> {
    const policy = await this.radiusConfig.getPolicy();
    if (policy.policyVersion === 'v2' && policy.v2) {
      return radiusKmToKRing(policy.v2.PUJA.broadcastRadiusKm);
    }
    const { matchKRing } = await this.radiusConfig.getKRings();
    return matchKRing;
  }

  /**
   * Broadcast del bid a TODOS los conductores elegibles cercanos (no "el sistema elige uno"):
   * reutiliza el hot-index para encontrar candidatos por celda H3 + tipo de vehículo, filtra los
   * excluidos por pánico, y usa el mecanismo existente de entrega de ofertas (`dispatch.offered`)
   * para notificar a cada candidato que hay un bid disponible al que PUEDE responder.
   */
  private async broadcast(board: OfferBoard): Promise<void> {
    const center = toH3(board.origin, DISPATCH_H3_RESOLUTION);
    // Radio del broadcast leído en RUNTIME (config editable por el admin, cacheado). v2 → radiusKmToKRing(
    // broadcastRadiusKm); v1 → matchKRing (comportamiento actual). Single-shot: sin loop de umbral (PUJA
    // difunde a TODOS los elegibles del radio de una — a diferencia del matcher FIXED, que oferta a uno).
    const cells = neighbors(center, await this.resolveBroadcastKRing());
    // Candidatos elegibles (disponibles + del tipo del board + que SATISFACEN los `requires` de la oferta +
    // no excluidos por pánico). Filtrado centralizado en DriverPool (misma fuente que el matcher secuencial
    // FIXED). B5-3 — el board YA lleva `category`: derivamos sus `requires` y se los pasamos a `eligible()`
    // para que el broadcast no llegue a conductores de un tier que no cumplen (paridad con FIXED). El gate
    // de submit/accept re-valida igual (defensa en profundidad); esto solo evita el ruido del broadcast.
    const candidates = await this.driverPool.eligible(cells, board.vehicleType, {
      requires: findOffering(board.category ?? '')?.requires,
    });

    const expiresAtIso = new Date(board.expiresAt).toISOString();
    // A1 — UNA sola llamada de ETA en LOTE (OSRM `/table` / motor local mapeado) en vez de N×`eta`
    // secuencial awaiteado: el origen de cada candidato → el origen del board, en una pasada. El array
    // viene alineado con `candidates`; si el lote entero falla, cae a 0 (no rompe el broadcast).
    let etas: number[] = [];
    try {
      etas = await this.maps.etaBatch(
        candidates.map((c) => ({ lat: c.lat, lon: c.lon })),
        board.origin,
      );
    } catch (err) {
      this.logger.warn(
        `ETA en lote no disponible en broadcast trip=${board.tripId}: ${String(err)}`,
      );
    }
    await Promise.all(
      candidates.map((cand, i) => {
        const etaSeconds = etas[i] ?? 0;
        // matchId efímero por (trip, driver): identifica la notificación de bid, no un match durable.
        const matchId = `bid:${board.tripId}:${cand.driverId}`;
        return Promise.resolve(
          this.offerDelivery.deliver({
            matchId,
            tripId: board.tripId,
            driverId: cand.driverId,
            etaSeconds,
            attempt: 1,
            score: 0,
            surgeMultiplier: 1,
            expiresAt: expiresAtIso,
            // Enrich de PUJA: el ping lleva monto/origen/vehículo/specials del board (MISMO derivador que
            // `GET /bids/open`) para que el conductor pinte la tarjeta de puja sin un refetch.
            bid: bidFieldsFromBoard(board),
          }),
        ).catch((err) => this.logger.warn(`broadcast a ${cand.driverId} falló: ${String(err)}`));
      }),
    );
    this.logger.log(
      `bid trip=${board.tripId} difundido a ${candidates.length} conductores elegibles`,
    );
  }

  // ── Submit de oferta (conductor) ─────────────────────────────────────────────────────────────

  /**
   * El conductor oferta sobre un board OPEN. Aplica el GATE de elegibilidad (ADR §6, cierre #9),
   * valida el precio según `kind`, y emite `dispatch.offer_made` por outbox. Idempotente por
   * (tripId, driverId): re-submit ACTUALIZA la oferta existente.
   */
  async submitOffer(input: SubmitOfferInput): Promise<Offer> {
    const board = await this.store.getBoard(input.tripId);
    if (!board) throw new NotFoundError('Puja no encontrada', { tripId: input.tripId });
    if (board.status !== BoardStatus.OPEN) {
      throw new ConflictError('La puja ya no está abierta', { status: board.status });
    }

    // Capa 3 (service): re-valida elegibilidad contra identity + vehículo + TIER (board.category). NO basta
    // presencia GPS. B5-3 — un conductor de tier inferior NO puede ofertar a un bid de tier superior.
    await this.eligibility.assertEligibleToOffer(
      input.driverId,
      board.vehicleType,
      false,
      board.category,
      true, // measureTier: submit ES una decisión de tier por-board → mide absent/unknown (no el poll)
    );

    if (input.kind === OfferKind.ACCEPT_PRICE && input.priceCents !== board.bidCents) {
      throw new ValidationError('ACCEPT_PRICE debe igualar el bid', {
        bidCents: board.bidCents,
        priceCents: input.priceCents,
      });
    }
    if (input.kind === OfferKind.COUNTER && input.priceCents <= board.bidCents) {
      throw new ValidationError('COUNTER debe ser mayor al bid', {
        bidCents: board.bidCents,
        priceCents: input.priceCents,
      });
    }
    // Techo de la contraoferta (gate de dominio): un COUNTER pasa a ser el fareCents del viaje si el
    // pasajero lo acepta, así que tampoco puede superar el techo (anti-abuso/anti-overflow int4).
    if (input.kind === OfferKind.COUNTER && input.priceCents > this.bidMaxCents) {
      throw new ValidationError('COUNTER supera el techo permitido', {
        priceCents: input.priceCents,
        maxCents: this.bidMaxCents,
      });
    }

    let etaSeconds = 0;
    const loc = await this.hotIndex.getLocation(input.driverId);
    if (loc) {
      try {
        etaSeconds = await this.maps.eta({ lat: loc.lat, lon: loc.lon }, board.origin);
      } catch (err) {
        this.logger.warn(`ETA no disponible para oferta trip=${input.tripId}: ${String(err)}`);
      }
    }

    const offer: Offer = {
      tripId: input.tripId,
      driverId: input.driverId,
      kind: input.kind,
      priceCents: input.priceCents,
      etaSeconds,
      status: OfferStatus.PENDING,
      updatedAt: Date.now(),
    };
    const ttl =
      Math.max(1, Math.ceil((board.expiresAt - Date.now()) / 1000)) +
      OfferBoardService.TTL_MARGIN_SECONDS;
    // Escritura ATÓMICA: el HSET ocurre SOLO si el board sigue OPEN dentro del mismo script. Cierra el
    // edge de la oferta-tras-cierre (entre el getBoard inicial y este punto el board pudo cerrarse).
    const stored = await this.store.submitOfferIfOpen(offer, ttl);
    if (!stored) {
      throw new ConflictError('La puja ya no está abierta', { tripId: input.tripId });
    }

    // dedupKey ESTABLE por (trip, driver, kind, price): una redelivery at-least-once del MISMO emit
    // dedupea downstream, pero una oferta GENUINAMENTE distinta (re-submit que sube el precio o cambia
    // de ACCEPT_PRICE→COUNTER) emite con clave nueva. No lleva uuid → ya no es única por construcción.
    await this.emit(
      'dispatch.offer_made',
      input.tripId,
      {
        tripId: input.tripId,
        driverId: input.driverId,
        kind: input.kind,
        priceCents: input.priceCents,
        etaSeconds,
      },
      dedupOfferMade(input.tripId, input.driverId, input.kind, input.priceCents),
    );
    return offer;
  }

  // ── Aceptación de una oferta (el pasajero elige UNA) ─────────────────────────────────────────

  /**
   * El pasajero eligió la oferta de `driverId`. Cierra el board (CLOSED_MATCHED), marca esa oferta
   * ACCEPTED y las demás LAPSED, emite `dispatch.offer_accepted` Y `dispatch.match_found` (para que
   * trip materialice ASSIGNED — se mantiene ese contrato). Idempotente: doble-tap → no-op.
   */
  async acceptOffer(tripId: string, driverId: string, passengerId: string): Promise<Offer> {
    const board = await this.store.getBoard(tripId);
    if (!board) throw new NotFoundError('Puja no encontrada', { tripId });

    // CAPA 2 (defensa en profundidad anti-IDOR/confused-deputy): el board pertenece al pasajero que
    // abrió la puja. Va ANTES del getOffer y de cualquier corto-circuito idempotente: un pasajero ajeno
    // (aud public-rail válido pero otro userId) NO puede materializar el match de un viaje que no es suyo.
    // El driverId del body SE QUEDA intacto (el pasajero ELIGE conductor; lo que se ancla es el dueño).
    if (board.passengerId !== passengerId) {
      throw new ForbiddenError('El viaje no pertenece al pasajero', { tripId });
    }

    const chosen = await this.store.getOffer(tripId, driverId);
    if (!chosen) throw new NotFoundError('Oferta no encontrada', { tripId, driverId });

    // Doble-tap idempotente del MISMO conductor ya ACEPTADO: cortocircuita ANTES de re-validar.
    // Un conductor que ya quedó asignado a ESTE viaje no necesita seguir AVAILABLE para que el
    // segundo tap del pasajero sea un no-op (si no, una identity flap convertiría el doble-tap en error).
    if (board.status === BoardStatus.CLOSED_MATCHED && chosen.status === OfferStatus.ACCEPTED) {
      return chosen;
    }

    // N4 (defensa en profundidad): SOLO una oferta PENDING es aceptable. Una oferta ya LAPSED (ventana
    // expirada), STALE (conductor que dejó de ser elegible), WITHDRAWN o ACCEPTED-de-otra-ronda NO se
    // puede aceptar — su precio ya no es vinculante. Rechazamos con 409 distinguible para que la UI
    // refresque la lista y el pasajero elija OTRA. Va DESPUÉS del corto-circuito idempotente (un doble-tap
    // del ya-ACCEPTED no llega acá) y ANTES de la re-validación/claim atómico (no tocamos H1/H3).
    if (chosen.status !== OfferStatus.PENDING) {
      this.logger.log(
        `accept rechazado trip=${tripId} driver=${driverId}: oferta ${chosen.status} (no PENDING)`,
      );
      throw new ConflictError('La oferta elegida ya no está disponible', {
        tripId,
        driverId,
        status: chosen.status,
        reason: 'offer_not_pending',
      });
    }

    // N8 (defensa en profundidad): re-valida el PRECIO de la oferta contra el bid ACTUAL del board. El
    // clear de openBoard ya purga las ofertas viejas en un re-bid, pero acá cerramos el edge en que una
    // oferta sobreviviera a un cambio de bid (precio rancio): facturaríamos `chosen.priceCents` sin
    // compararlo nunca con `board.bidCents` vigente, y el pasajero que SUBIÓ el bid podría aceptar una
    // oferta vieja barata. Regla por `kind`: un ACCEPT_PRICE debe IGUALAR el bid actual; un COUNTER debe
    // seguir siendo (bid_actual, techo]. Si el precio ya no es válido para el bid vigente → 409 distinguible
    // (`offer_price_stale`) para que la UI refresque y el pasajero elija otra. Va tras el guard PENDING y
    // ANTES del claim atómico (no toca H1/H3).
    const priceValid =
      chosen.kind === OfferKind.ACCEPT_PRICE
        ? chosen.priceCents === board.bidCents
        : board.bidCents < chosen.priceCents && chosen.priceCents <= this.bidMaxCents;
    if (!priceValid) {
      this.logger.log(
        `accept rechazado trip=${tripId} driver=${driverId}: precio rancio ${chosen.priceCents} ` +
          `(${chosen.kind}) vs bid actual ${board.bidCents}`,
      );
      throw new ConflictError('El precio de la oferta ya no es válido para el bid actual', {
        tripId,
        driverId,
        offerPriceCents: chosen.priceCents,
        bidCents: board.bidCents,
        reason: 'offer_price_stale',
      });
    }

    // Cierre #6 (oferta rancia): el conductor pudo quedar OFFLINE / tomar otro viaje / ser suspendido
    // ENTRE que ofertó y que el pasajero eligió. Re-validamos su elegibilidad contra la MISMA fuente
    // autoritativa del submit (identity online/AVAILABLE + !suspendido + vehículo) ANTES del claim
    // atómico, para que el board quede OPEN si falla y el pasajero pueda elegir OTRA oferta. Marcamos
    // la oferta STALE para que desaparezca de la lista. El código 'driver_unavailable' deja que la UI
    // diga "ese conductor ya no está disponible, elegí otro".
    try {
      // A4 — BYPASS del cache (`fresh=true`): el accept es la decisión de plata. Un conductor recién
      // suspendido NO puede colarse por un snapshot stale de hasta `ELIGIBILITY_CACHE_TTL_MS` al match.
      // B5-3 — re-valida también el TIER (board.category): un tier inferior no se cuela al match.
      // accept: decisión de tier por-board (fresh=true bypasea cache) → measureTier=true mide absent/unknown.
      await this.eligibility.assertEligibleToOffer(
        driverId,
        board.vehicleType,
        true,
        board.category,
        true,
      );
    } catch {
      await this.store.setOfferStatus(tripId, driverId, OfferStatus.STALE);
      // BE-3 — la oferta dejó de ser válida con el board OPEN: avisamos al pasajero para que la QUITE al
      // instante (el board sigue abierto para elegir otra). Idempotente por (trip,driver); best-effort: un
      // fallo del emit no debe tapar el ConflictError que el pasajero necesita ver.
      await this.emit(
        'dispatch.offer_withdrawn',
        tripId,
        { tripId, driverId, reason: OFFER_WITHDRAWN_REASON.STALE },
        dedupOfferWithdrawn(tripId, driverId, board.negotiationSeq),
      ).catch((err: unknown) =>
        this.logger.warn(
          `offer_withdrawn no emitido trip=${tripId} driver=${driverId}: ${String(err)}`,
        ),
      );
      this.logger.log(`oferta rancia trip=${tripId} driver=${driverId} → STALE (board sigue OPEN)`);
      throw new ConflictError('La oferta elegida ya no está disponible (conductor no elegible)', {
        tripId,
        driverId,
        reason: 'driver_unavailable',
      });
    }

    // GATE atómico de ganador único (CAS OPEN→CLOSED_MATCHED en Redis). Cierra H1: dos aceptaciones
    // concurrentes de conductores DISTINTOS compiten por este claim; SOLO una obtiene claimed=true.
    // El perdedor (claimed=false) NO escribe estado ni emite eventos — solo decide idempotencia vs 409.
    const claim = await this.store.claimBoardForAccept(tripId, driverId, Date.now());
    if (!claim.claimed) {
      // Acá `chosen` ya está narrowed a PENDING (el guard N4 de arriba descartó ACCEPTED/LAPSED/STALE/
      // WITHDRAWN). El doble-tap idempotente del MISMO conductor ya ACCEPTED se atiende ANTES, en el
      // corto-circuito del tope (board CLOSED_MATCHED + chosen ACCEPTED): re-lee la oferta fresca, la ve
      // ACCEPTED y retorna sin llegar nunca hasta acá. Por eso, perder el claim con una oferta PENDING
      // (cerró con OTRO conductor, EXPIRED, CANCELLED, o desapareció) es SIEMPRE conflicto.
      throw new ConflictError('La puja ya no está abierta', { status: claim.status });
    }

    // A partir de acá ganamos el claim atómico del BOARD: somos los únicos que materializan ESTE match.
    //
    // A2 (ADR-021 Fase A) — CINTURÓN SÍNCRONO per-conductor. El CAS del board garantiza un único ganador
    // POR board, pero NO cubre la carrera de dos accepts de boards DISTINTOS que eligen al MISMO conductor
    // a la vez: A1 flipea `currentStatus`→ON_TRIP de forma ASÍNCRONA (Kafka), así que en la ventana de ~ms
    // ambos accepts pasan el `eligibility.gate` (leen AVAILABLE) y ambos ganarían su board → doble-win.
    // Reclamamos al conductor de forma ATÓMICA (Redis SET NX) DESPUÉS de ganar el board y ANTES de la tx
    // durable: si el claim falla (el conductor YA ganó en OTRO board) revertimos NUESTRO board (→ OPEN, el
    // pasajero elige otro) y rechazamos con 409 — así una claim perdida NO deja un match a medio hacer.
    // Idempotente: si la claim ya es de ESTE mismo tripId (redelivery/retry del mismo accept), es éxito.
    const driverClaimed = await this.hotIndex.tryClaimDriver(
      driverId,
      tripId,
      OfferBoardService.DRIVER_CLAIM_TTL_SECONDS,
    );
    if (!driverClaimed) {
      // El conductor ya fue reclamado por OTRO viaje → compensamos el board claim (CLOSED_MATCHED → OPEN,
      // MISMA compensación que la tx-fail) para que el pasajero pueda elegir otro conductor, y rechazamos
      // con 409 distinguible (`driver_claimed`) para que public-bff lo surface → la UI del pasajero refetch.
      await this.store
        .revertClaim(tripId)
        .catch((revertErr) =>
          this.logger.error(
            `A2 trip=${tripId} driver=${driverId}: conductor ya reclamado y el revert del board falló ` +
              `(board CLOSED_MATCHED sin match — lo rescata el reconciler): ${String(revertErr)}`,
          ),
        );
      this.logger.log(
        `accept rechazado trip=${tripId} driver=${driverId}: conductor ya reclamado por otro viaje (A2)`,
      );
      throw new ConflictError('El conductor ya fue asignado a otro viaje', {
        tripId,
        driverId,
        reason: 'driver_claimed',
      });
    }

    // Ganado el board Y el conductor: somos los únicos que materializan este match.
    //
    // N5 — orden DURABLE-PRIMERO: la commit del outbox (la verdad durable del match) ocurre ANTES de
    // tocar el estado EFÍMERO de las ofertas en Redis. Así, si la tx de Postgres FALLA, NINGUNA oferta
    // quedó flipeada y solo hay que revertir el board (CLOSED_MATCHED → OPEN). Sin esto, un fallo de la
    // tx dejaba el board CERRADO sin match_found jamás emitido → trip huérfano en REQUESTED y, peor, el
    // watchdog lo EXPIRAría (resultado equivocado para un viaje que SÍ matcheó). El revert compensatorio
    // re-abre la ventana para que el pasajero reintente el accept (las ofertas siguen ahí, ventana vigente).
    try {
      // offer_accepted + match_found en la MISMA transacción de outbox (FOUNDATION §6).
      await this.repo.runInTx(async (tx) => {
        const acceptedDedup = dedupOfferAccepted(tripId, driverId);
        const accepted = createEnvelope({
          eventType: 'dispatch.offer_accepted',
          producer: 'dispatch-service',
          // H13 — estampa el seq del CICLO del board: trip lo exige en applyAgreedFare para descartar una
          // redelivery de un ciclo viejo (la tarifa rancia del conductor anterior no debe escribirse).
          payload: {
            tripId,
            driverId,
            priceCents: chosen.priceCents,
            negotiationSeq: board.negotiationSeq,
          },
          dedupKey: acceptedDedup,
        });
        await tx.outboxEvent.create({
          data: {
            aggregateId: tripId,
            eventType: accepted.eventType,
            // Finding #4a — idempotencia del productor: la MISMA clave estable que el envelope se persiste
            // en la columna unique → un re-insert (reconcile/retry) lo rechaza con P2002 (lo tragamos abajo).
            dedupKey: acceptedDedup,
            envelope: accepted as unknown as Prisma.InputJsonValue,
          },
        });
        const matchFoundDedup = dedupMatchFound(tripId, driverId);
        const matchFound = createEnvelope({
          eventType: 'dispatch.match_found',
          producer: 'dispatch-service',
          payload: { tripId, driverId, scoreMs: 0 },
          dedupKey: matchFoundDedup,
        });
        await tx.outboxEvent.create({
          data: {
            aggregateId: tripId,
            eventType: matchFound.eventType,
            dedupKey: matchFoundDedup,
            envelope: matchFound as unknown as Prisma.InputJsonValue,
          },
        });
        // RECORD de ASIGNACIÓN: el flujo PUJA cierra el match acá (lo elige el pasajero), no por el
        // matching secuencial — pero el ciclo de vida del conductor (release al completar/cancelar,
        // exclusión por pánico) resuelve "quién está asignado a este viaje" vía DispatchMatch ACCEPTED
        // (driverForTrip/excludeDriverForPanic). Sin este row, la PUJA dejaba al conductor markBusy SIN
        // forma de liberarlo → quedaba fuera del pool hasta el TTL (2h). Lo persistimos en la MISMA tx que
        // el match (atómico). score/attempt no aplican a la PUJA (no hay ranking): 0/1. surgeMultiplier
        // queda en su default (la tarifa PUJA es el bid acordado, no lleva surge sobre el match).
        // Finding #11 — agreedPriceCents es la FUENTE DE VERDAD DURABLE del precio acordado: el
        // reconciliador lo lee de acá (NUNCA fabrica un precio desde el board/oferta efímeros de Redis).
        // El índice UNIQUE PARCIAL (WHERE outcome='ACCEPTED') hace que un SEGUNDO insert ACCEPTED para el
        // mismo trip lance P2002 (defensa-en-profundidad sobre el claim/CAS, que ya garantiza un solo writer).
        await tx.dispatchMatch.create({
          data: {
            id: uuidv7(),
            tripId,
            driverId,
            score: new Prisma.Decimal(0),
            attempt: 1,
            outcome: DispatchOutcome.ACCEPTED,
            agreedPriceCents: chosen.priceCents,
            respondedAt: new Date(),
          },
        });
      });
    } catch (txErr) {
      // Finding #4a — el accept es single-writer por el claim/CAS, así que un P2002 acá es extremadamente
      // improbable (re-insert de la misma dedupKey o segundo ACCEPTED del mismo trip): aun así NO debe
      // crashear el accept — significa que el match YA quedó materializado. Lo tratamos como idempotente:
      // saltamos el revert (no des-reclamar un board cuyo match ya existe) y seguimos al markMatchEmitted.
      if (isUniqueViolation(txErr)) {
        this.logger.debug(
          `accept trip=${tripId} driver=${driverId}: P2002 (match/evento ya materializado) → no-op idempotente`,
        );
      } else {
        // Acción COMPENSATORIA: la tx durable falló → des-reclamar el board (CLOSED_MATCHED → OPEN) para
        // que el pasajero pueda reintentar. Best-effort + logueado: si el revert también falla, el board
        // queda CLOSED_MATCHED sin match (residual del hard-crash, lo cubre el reconciler del barrido).
        try {
          await this.store.revertClaim(tripId);
          this.logger.warn(
            `accept trip=${tripId} driver=${driverId}: outbox tx falló → board revertido a OPEN (reintentable)`,
          );
        } catch (revertErr) {
          this.logger.error(
            `accept trip=${tripId} driver=${driverId}: outbox tx falló Y el revert del board falló ` +
              `(board CLOSED_MATCHED sin match — lo rescata el reconciler): ${String(revertErr)}`,
          );
        }
        // A2 — soltamos también el claim per-conductor: la tx durable falló y el match NO existe, así que el
        // conductor debe volver a ser reclamable de inmediato (si no, quedaría bloqueado hasta el TTL de 2h).
        // Best-effort: un fallo del release no debe tapar el txErr que el pasajero necesita ver (el TTL es el backstop).
        await this.hotIndex
          .releaseClaim(driverId)
          .catch((relErr) =>
            this.logger.warn(
              `A2 releaseClaim (tx-fail) trip=${tripId} driver=${driverId}: ${String(relErr)}`,
            ),
          );
        throw txErr;
      }
    }

    // La tx durable COMMITEÓ: marcamos el board como match-emitido (flag para el reconciler de N5, que
    // re-emite match_found para boards CLOSED_MATCHED sin esta marca — el residual del crash entre el
    // claim y este punto). Best-effort: si falla, el board sigue CLOSED_MATCHED sin la marca y el
    // reconciler re-emitiría un match_found idempotente (mismo dedupKey) — inofensivo.
    await this.store
      .markMatchEmitted(tripId)
      .catch((err) =>
        this.logger.warn(`no se pudo marcar matchEmitted trip=${tripId}: ${String(err)}`),
      );

    // ADR-020 Lote 2 (2a) — captura los PERDEDORES (ofertas PENDING de OTROS conductores) ANTES del flip
    // cosmético a LAPSED, para notificarles reactivamente. `lapseAndAccept` flipea las N-1 ofertas a LAPSED
    // en Redis SIN emitir evento: sin esto, el conductor perdedor conservaba su card de puja hasta que
    // caducara localmente y, al tapearla, chocaba con un board ya cerrado → 409. La lista se lee del HASH
    // (aún PENDING en este punto): el winner se excluye por driverId.
    const losers = (await this.store.listOffers(tripId)).filter(
      (o) => o.driverId !== driverId && o.status === OfferStatus.PENDING,
    );

    // Recién AHORA flipeamos el estado efímero de las ofertas (elegida ACCEPTED, resto LAPSED): el match
    // ya es durable, así que estas escrituras son cosméticas (alimentan la vista del pasajero) y un fallo
    // parcial acá NO corrompe el outcome del match. A5 — UN solo round-trip (Lua sobre el HASH) en vez
    // de N×setOfferStatus (cada uno HGET+HSET); best-effort, un fallo acá no afecta el match durable.
    await this.store
      .lapseAndAccept(tripId, driverId)
      .catch((err) =>
        this.logger.warn(`lapseAndAccept trip=${tripId} falló (cosmético): ${String(err)}`),
      );

    // ADR-020 Lote 2 (2a) — UN `dispatch.offer_withdrawn` (reason=not_selected) POR perdedor, por OUTBOX
    // (idempotente por (trip,driver) vía dedupOfferWithdrawn). El driver-bff lo consume y empuja `bid:closed`
    // al conductor → su card muere al instante, sin esperar el poll de 12s y sin tapear un board cerrado.
    // Sin PII: SOLO tripId + driverId. Best-effort/cosmético (post-durable): un fallo del emit NO afecta el
    // match ya materializado; el poll de 12s del conductor es el backstop. Un perdedor que ya recibió un
    // offer_withdrawn (p.ej. reason=stale en un accept previo fallido) dedupea acá por la MISMA clave.
    await Promise.all(
      losers.map((loser) =>
        this.emit(
          'dispatch.offer_withdrawn',
          tripId,
          { tripId, driverId: loser.driverId, reason: OFFER_WITHDRAWN_REASON.NOT_SELECTED },
          dedupOfferWithdrawn(tripId, loser.driverId, board.negotiationSeq),
        ).catch((err: unknown) =>
          this.logger.warn(
            `offer_withdrawn (not_selected) trip=${tripId} driver=${loser.driverId}: ${String(err)}`,
          ),
        ),
      ),
    );

    // markBusy se mantiene acá (Lote separado): el claim atómico ya garantiza que solo este camino
    // llega hasta acá, así que no hay carrera de doble-markBusy para este board.
    await this.hotIndex.markBusy(driverId);
    this.logger.log(`board trip=${tripId} CLOSED_MATCHED → driver=${driverId}`);
    return { ...chosen, status: OfferStatus.ACCEPTED };
  }

  /**
   * Ofertas VISIBLES para el pasajero (el public-bff hace ownership-gate antes de llamar). N6: solo las
   * ACEPTABLES (PENDING). Las muertas — STALE (conductor no elegible), LAPSED (ventana cerrada),
   * WITHDRAWN, ACCEPTED — NO se muestran: el pasajero solo ve lo que realmente puede elegir, y no puede
   * tocar una oferta rancia que el accept-guard rechazaría igual. El store sigue devolviendo TODO el HASH
   * (lo usan acceptOffer/sweepExpired para transicionar estados); el filtro vive SOLO en esta vista.
   */
  async listOffers(tripId: string): Promise<Offer[]> {
    const offers = await this.store.listOffers(tripId);
    return offers.filter((o) => o.status === OfferStatus.PENDING);
  }

  /**
   * FIX contrato — vista del board + ofertas para el pasajero. El cliente necesita saber el ESTADO del
   * board (no solo las ofertas) para distinguir "puja viva sin ofertas aún" de "puja cancelada/expirada/
   * cerrada/evaporada por TTL" sin adivinar por un array vacío. El public-bff hace ownership-gate antes.
   *
   *  - `status`: el estado del board, o `'GONE'` cuando la key ya NO existe en Redis (expiró por TTL).
   *  - `expiresAt`: epoch(ms) de vencimiento de la ventana (sólo informativo); null si el board no existe.
   *  - `offers`: SOLO con un board OPEN se devuelven las PENDING. Si el board está CANCELLED/EXPIRED/
   *    CLOSED_MATCHED o ausente (GONE), `offers = []` — nunca ofertas zombies de una puja ya muerta (el
   *    pasajero no debe poder aceptar sobre un board cerrado; el accept-guard las rechazaría igual).
   */
  async getOffersView(tripId: string, passengerId: string): Promise<OffersView> {
    const board = await this.store.getBoard(tripId);
    if (!board) {
      // La key del board ya no existe en Redis (TTL): la puja se evaporó. GONE + sin ofertas.
      // El guard de ownership va DESPUÉS de este check a propósito: un board evaporado no tiene
      // passengerId que comparar y devolver GONE no leakea NADA (no expone ofertas ni estado ajeno).
      return { board: { status: ClientBoardStatus.GONE, expiresAt: null }, offers: [] };
    }
    // CAPA 2 (defensa en profundidad anti-IDOR): solo el dueño de la puja ve sus ofertas. Va tras el
    // check GONE (ese ya no tiene ancla de ownership) y antes de exponer cualquier oferta del board.
    if (board.passengerId !== passengerId) {
      throw new ForbiddenError('El viaje no pertenece al pasajero', { tripId });
    }
    // Solo un board OPEN expone ofertas elegibles; cualquier otro estado → [] (no zombies).
    const offers =
      board.status === BoardStatus.OPEN
        ? (await this.store.listOffers(tripId)).filter((o) => o.status === OfferStatus.PENDING)
        : [];
    return { board: { status: board.status, expiresAt: board.expiresAt }, offers };
  }

  /**
   * Fase B (ADR-021 · B-react) — el conductor pasó a OFFLINE (`driver.went_offline`): RETIRA todas sus
   * ofertas OPEN vivas de los boards para que su card desaparezca REACTIVA del board del pasajero, sin
   * esperar el gate de accept (cierre #6) ni el TTL. Recorre los boards OPEN (los únicos que colectan
   * ofertas) y, por cada uno con una oferta PENDING del conductor, la marca STALE + emite
   * `dispatch.offer_withdrawn` (reason=stale) — el MISMO camino que la oferta-rancia del accept, reusado.
   * Idempotente por (trip, driver, ciclo) vía `dedupOfferWithdrawn`; best-effort: un conductor sin ofertas
   * abiertas es no-op y un fallo de un emit se loguea sin abortar el resto. Devuelve el #ofertas retiradas.
   */
  async withdrawDriverOffers(driverId: string): Promise<number> {
    const boards = await this.store.listOpenBoards(Date.now());
    let withdrawn = 0;
    for (const board of boards) {
      const offer = await this.store.getOffer(board.tripId, driverId);
      if (!offer || offer.status !== OfferStatus.PENDING) continue;
      await this.store.setOfferStatus(board.tripId, driverId, OfferStatus.STALE);
      await this.emit(
        'dispatch.offer_withdrawn',
        board.tripId,
        { tripId: board.tripId, driverId, reason: OFFER_WITHDRAWN_REASON.STALE },
        dedupOfferWithdrawn(board.tripId, driverId, board.negotiationSeq),
      ).catch((err: unknown) =>
        this.logger.warn(
          `offer_withdrawn (offline) trip=${board.tripId} driver=${driverId}: ${String(err)}`,
        ),
      );
      withdrawn++;
      this.logger.log(`conductor offline: oferta trip=${board.tripId} driver=${driverId} → STALE`);
    }
    return withdrawn;
  }

  /**
   * Lista las pujas OPEN que el conductor `driverId` PUEDE ofertar (lado conductor, ADR §6):
   *  1. RE-VALIDA elegibilidad contra identity (online + !suspendido). Si no es elegible → 403.
   *  2. Solo boards cuyo `vehicleType` coincide con el vehículo ACTIVO del conductor (hot-index).
   *  3. Solo boards cuya celda de origen cae dentro del k-ring del conductor (cercanía).
   * Cada board sale ENRIQUECIDO con `pickupEtaSeconds` (ETA conductor→recojo): es EL dato de decisión de
   * la card de puja (la oferta FIXED ya lo muestra como "A recojo") y antes solo viajaba en el ping
   * `dispatch.offered` — el poll (la fuente que pinta la card) lo perdía. 0 = no disponible (maps caído):
   * el DTO lo omite para que la app degrade el stat en vez de pintar un "0 min" engañoso.
   * El `driverId` lo deriva el driver-bff server-side (nunca un param del cliente). La elegibilidad se
   * enforce ACÁ además del guard del BFF (defensa en profundidad). Devuelve [] si no hay ubicación viva.
   */
  async listOpenBidsNear(driverId: string): Promise<NearbyOpenBid[]> {
    const loc = await this.hotIndex.getLocation(driverId);
    if (!loc) return [];
    // El gate re-valida online/suspendido; si el conductor no es elegible para ofertar → 403.
    await this.eligibility.assertEligibleToOffer(driverId, loc.vehicleType);

    const center = toH3({ lat: loc.lat, lon: loc.lon }, DISPATCH_H3_RESOLUTION);
    // MISMO radio que el broadcast (paridad conductor↔difusión: un conductor debe VER en su poll los boards
    // que se le difundirían). v2 → broadcastRadiusKm; v1 → matchKRing.
    const cells = neighbors(center, await this.resolveBroadcastKRing());
    // A3/H11 — índice inverso celda→board: trae SOLO los boards cuyo ORIGEN cae en el k-ring del conductor
    // (ZRANGEBYSCORE `board:cell:<c>` <now>..+inf + MGET de ESOS candidatos), no TODOS los OPEN del
    // platform-wide. El costo del poll pasa de O(total open boards) a O(boards en el k-ring). El ZSET ya
    // pre-excluye los vencidos por score y poda los muertos por TTL; el filtro en Node es belt-and-suspenders
    // sobre ese conjunto ACOTADO: OPEN + ventana viva + vehículo.
    const now = Date.now();
    const currentYear = new Date().getUTCFullYear();
    const candidates = await this.store.boardsInCells(cells);
    const nearby = candidates.filter(
      (b) =>
        b.status === BoardStatus.OPEN &&
        b.expiresAt > now &&
        b.vehicleType === loc.vehicleType &&
        // B5-3 — además del vehicleType, el board debe cumplir los `requires` de SU oferta para que el
        // conductor lo vea/poll-ee: un tier inferior NO debe encontrar boards de tier superior. Misma
        // semántica del pool/gate (certs fail-closed, attrs fail-open).
        this.boardMeetsRequires(b.category, loc, currentYear),
    );
    // ETA conductor→origen POR board. Es la dirección INVERSA a `etaBatch` (N orígenes → 1 destino; acá
    // es 1 origen → N destinos), así que va por `eta` individual en paralelo: N está ACOTADO por los
    // boards OPEN del k-ring del conductor (unidades, no cientos — a diferencia del broadcast A1, que
    // rankea cientos de candidatos). Si algún día crece, el paso es un one→many en @veo/maps (/table de
    // OSRM lo soporta). Fallo por-board cae a 0 (se omite downstream), NUNCA rompe el poll.
    const etas = await Promise.all(
      nearby.map((b) =>
        this.maps.eta({ lat: loc.lat, lon: loc.lon }, b.origin).catch(() => 0),
      ),
    );
    return nearby.map((board, i) => ({ board, pickupEtaSeconds: etas[i] ?? 0 }));
  }

  /**
   * B5-3 — ¿el conductor (`loc` del hot-index) satisface los `requires` de la oferta del board? Espeja
   * `DriverPool.passesEligibility` y la rama de tier del `EligibilityGate`: certs FAIL-CLOSED (una vertical
   * exige credencial válida), attrs del vehículo (seats/segment/año) FAIL-OPEN (un ping legacy sin attrs NO
   * se excluye, para no romper el rollout). Category ausente/desconocida ⇒ sin requires ⇒ true (solo filtra
   * por vehicleType, como antes). Es un filtro de VISIBILIDAD/ruido; el gate de submit/accept re-valida igual.
   */
  private boardMeetsRequires(
    category: string | undefined,
    loc: DriverLocation,
    currentYear: number,
  ): boolean {
    const requires: OfferingRequirements | undefined = category
      ? findOffering(category)?.requires
      : undefined;
    if (!requires) return true;
    // Certs: FAIL-CLOSED — se evalúa SIEMPRE (independiente de los attrs del vehículo).
    if (!hasRequiredCertifications(requires, loc.certifications)) return false;
    // Attrs del vehículo: FAIL-OPEN — sin el dato (legacy) no se restringe.
    if (loc.seats === undefined || loc.segment === undefined || loc.vehicleYear === undefined) {
      return true;
    }
    return isVehicleEligibleForOffering(
      requires,
      { seats: loc.seats, segment: loc.segment, year: loc.vehicleYear },
      currentYear,
    );
  }

  /**
   * Cancela el board (el pasajero canceló la puja / el viaje) → CANCELLED. Idempotente. CAS atómico
   * OPEN→CANCELLED (cancelIfOpen): compite limpio con el claim del accept y el expire — si otro cierre
   * ganó, no-op (nunca pisa un CLOSED_MATCHED, como sí podía el read-then-write previo).
   *
   * `emitClosure` (default false) distingue los DOS llamadores:
   *  - PASAJERO cancela la PUJA (`POST /bids/:tripId/cancel`, vía REST del public-bff) → `emitClosure=true`:
   *    además de cerrar el board EFÍMERO, emite `dispatch.bid_cancelled` por OUTBOX TRANSACCIONAL (mismo
   *    patrón que `acceptOffer`/offer_accepted, FOUNDATION §6 regla #3) para que trip-service cierre el
   *    VIAJE (REQUESTED/REASSIGNING → CANCELLED_BY_PASSENGER). Sin esto el trip quedaba zombie en REQUESTED
   *    hasta el watchdog (~10min): single-live-trip bloqueaba re-pedir y los accepts caían en 409/404.
   *    El evento NO se puede perder → va por outbox (NO un emit best-effort fuera de tx).
   *  - `trip.cancelled` ya disparó (el VIAJE murió por OTRA vía: cancel terminal del pasajero/conductor) →
   *    `emitClosure=false`: solo mata el board fantasma. NO re-emitimos cierre (el trip YA está cerrando) —
   *    evita el bucle dispatch.bid_cancelled → trip.cancelled → cancelBoard → dispatch.bid_cancelled …
   *
   * IDEMPOTENTE + caso "cancelo a los 95s, el board ya murió por TTL": el CAS `cancelIfOpen` devuelve false
   * si el board no existe o ya no está OPEN; AUN ASÍ, con `emitClosure=true`, EMITIMOS el cierre — el VIAJE
   * del pasajero puede seguir REQUESTED aunque su board efímero se haya evaporado, y debe cerrarse igual. La
   * idempotencia real la da el guard-por-estado de trip-service (cancelFromBid): solo cierra desde
   * REQUESTED/REASSIGNING, así un cancel repetido / una redelivery / un trip ya terminal es no-op.
   *
   * LIMPIEZA: al cancelar purgamos también el HASH de ofertas (clearOffers) — hasta hoy solo se limpiaba en
   * openBoard/reopenBoard, dejando ofertas PENDING colgadas en Redis tras un cancel (zombies hasta su TTL).
   */
  /**
   * Camino del PASAJERO (HTTP, public-rail): cancela la puja anclada a SU ownership (anti-IDOR, CAPA 2).
   * `passengerId` viene de la identidad FIRMADA; el board debe pertenecerle o se rechaza con 403.
   */
  async cancelBoard(
    tripId: string,
    passengerId: string,
    opts?: { emitClosure?: boolean },
  ): Promise<void>;
  /**
   * Camino de SISTEMA (autoridad del viaje, p.ej. consumo de `trip.cancelled`): el trip ya murió por otra
   * vía → el board muere SIEMPRE, sin ancla de ownership (un evento de dominio interno no es forjable).
   */
  async cancelBoard(tripId: string, opts: { system: true; emitClosure?: boolean }): Promise<void>;
  async cancelBoard(
    tripId: string,
    ownerOrOpts: string | { system: true; emitClosure?: boolean },
    maybeOpts: { emitClosure?: boolean } = {},
  ): Promise<void> {
    // Discrimina los dos llamadores SIN `any`: un string → camino del pasajero (con guard de ownership);
    // un objeto `{ system: true }` → camino de sistema (sin guard, el board muere por autoridad del viaje).
    const system = typeof ownerOrOpts !== 'string';
    const passengerId = system ? null : ownerOrOpts;
    const opts = system ? ownerOrOpts : maybeOpts;

    // CAPA 2 (defensa en profundidad anti-IDOR): en el camino del PASAJERO, SI el board existe solo su dueño
    // puede cancelarlo — un pasajero ajeno NO cancela la puja de otro. SI el board ya se evaporó por TTL
    // (board null), NO hay ancla de ownership que validar: NO tiramos error y seguimos al cancelIfOpen/
    // emitClosure tal cual (preserva el caso "cancelo a 95s": cancelIfOpen devuelve false pero con
    // emitClosure=true el cierre del viaje se emite igual). LÍMITE RESIDUAL: un board efímero sin ancla
    // tras TTL queda cubierto por CAPA 1 (AudienceGuard public-rail) + la autoridad DURABLE de trip-service
    // (cancelFromBid guard-ea por estado: solo cierra desde REQUESTED/REASSIGNING). El camino de SISTEMA
    // (`system:true`) salta el guard a propósito: el trip ya murió y el board debe morir sin importar dueño.
    if (!system) {
      const board = await this.store.getBoard(tripId);
      if (board && board.passengerId !== passengerId) {
        throw new ForbiddenError('El viaje no pertenece al pasajero', { tripId });
      }
    }
    const cancelled = await this.store.cancelIfOpen(tripId);
    if (cancelled) {
      // GAP #1 (2026-07-15) — NOTIFICAR a los conductores que ofertaron que la puja se canceló. Capturamos
      // las ofertas PENDING ANTES de limpiarlas: sin esto, `cancelBoard` solo hacía `clearOffers` (server-
      // side) y NINGÚN evento llegaba al conductor → su BidCard/"Esperando al pasajero…" sobrevivía hasta el
      // poll de 12s y un tap tardío daba 409. Emitimos un `dispatch.offer_withdrawn` (reason=cancelled) por
      // conductor → driver-bff lo empuja como `bid:closed` → la app quita la card AL INSTANTE. Es el MISMO
      // patrón de sweepExpired (stale)/acceptOffer (not_selected)/withdrawDriverOffers (offline).
      const pending = (await this.store.listOffers(tripId)).filter(
        (o) => o.status === OfferStatus.PENDING,
      );
      // Higiene: el board se canceló → ninguna oferta de esta ventana debe sobrevivir en el HASH.
      await this.store
        .clearOffers(tripId)
        .catch((err) =>
          this.logger.warn(`clearOffers (cancel) trip=${tripId} falló: ${String(err)}`),
        );
      // dedup por (trip,driver,'cancelled'): el HTTP-cancel del pasajero y el system-cancel (trip.cancelled)
      // corren para el MISMO viaje → el 2º no encuentra ofertas (ya limpias) y `cancelIfOpen` da false, pero
      // el dedup lo blinda igual ante re-entregas concurrentes. Sin PII (solo ids); best-effort (poll respalda).
      await Promise.all(
        pending.map((offer) =>
          this.emit(
            'dispatch.offer_withdrawn',
            tripId,
            { tripId, driverId: offer.driverId, reason: OFFER_WITHDRAWN_REASON.CANCELLED },
            dedupOfferWithdrawn(tripId, offer.driverId, 'cancelled'),
          ).catch((err: unknown) =>
            this.logger.warn(
              `offer_withdrawn (cancelled) trip=${tripId} driver=${offer.driverId}: ${String(err)}`,
            ),
          ),
        ),
      );
      this.logger.log(
        `board trip=${tripId} CANCELLED por el pasajero (${pending.length} ofertas retiradas)`,
      );
    }
    // Cierre del VIAJE (no solo del board): SIEMPRE que el llamador sea el cancel de la PUJA del pasajero,
    // aunque el board ya no exista (TTL) o ya estuviera cerrado — el trip puede seguir REQUESTED. El evento
    // va por outbox transaccional (no se puede perder); trip-service lo guard-ea por estado (idempotente).
    if (opts.emitClosure) {
      await this.emit(
        'dispatch.bid_cancelled',
        tripId,
        { tripId, reason: 'cancelled_by_passenger' },
        dedupBidCancelled(tripId),
      );
      this.logger.log(`emitido dispatch.bid_cancelled trip=${tripId} (cierre del viaje)`);
    }
  }

  // ── Expiración de ventana (barrido) ──────────────────────────────────────────────────────────

  /**
   * Barrido de boards OPEN vencidos. Lo invoca el tick del scheduler (@Interval). Para cada board
   * OPEN cuya ventana ya pasó sin aceptación: lo marca EXPIRED y emite `dispatch.no_offers`. El
   * `reason` es `all_lapsed` si HUBO ofertas (todas caducaron) o `window_expired` si nadie ofertó.
   */
  async sweepExpired(now = Date.now()): Promise<number> {
    // H8 — SOLO los boards cuya ventana YA venció (rango sobre el zset `board:expiry`), no todos los OPEN.
    // El costo del tick pasa de O(boards) a O(due): con N boards no vencidos, el barrido descubre que
    // nada vence con UN range-read, no con N GETs. Los boards aún vigentes NO se tocan (no se GET-ean).
    const ids = await this.store.dueBoardIds(now);
    let closed = 0;
    for (const tripId of ids) {
      // CAS atómico OPEN→EXPIRED (mutuamente excluyente con acceptOffer: si una aceptación gana el
      // claim, este expire devuelve expired:false y no emite nada; y viceversa). Así el board NUNCA
      // termina a la vez CLOSED_MATCHED y EXPIRED → se cierra el doble-fire (no_offers + match_found).
      // H8 — el Lua DEVUELVE el windowEpoch (expiresAt leído in-script): NO hay `getBoard` previo por board.
      const res = await this.store.expireIfOpen(tripId, now);
      if (!res.expired) {
        // No-op: o ya cerró (otro camino ganó la raza), o el board desapareció (TTL de Redis).
        // GAP #8: si desapareció pero su id COLGÓ en el zset, lo limpiamos (ZREM incondicional) para que
        // el barrido deje de re-procesarlo, y emitimos window_expired una vez. La dedupKey usa el
        // sentinel ('gone') porque la ventana ya no es conocible (el board no existe).
        if (!res.boardExists) {
          await this.store.removeOpenId(tripId);
          await this.expire(tripId, 'window_expired', `gone`);
          closed++;
        }
        continue;
      }
      // Ganamos el CAS: nosotros marcamos EXPIRED → solo nosotros emitimos no_offers.
      const reason = res.offerCount > 0 ? 'all_lapsed' : 'window_expired';
      // ADR-020 Lote 2 (2a, follow-up del boot-real) — captura las ofertas PENDING ANTES del lapse para
      // NOTIFICAR a esos conductores que su puja se cerró. Sin esto, un conductor que ofertó y quedó en
      // "Esperando al pasajero…" NO se enteraba al vencer el board (el offer_withdrawn solo se emitía al
      // ACEPTAR, no al expirar) → su estado pendiente quedaba STALE y bloqueaba re-ofertar el mismo viaje.
      const pending =
        res.offerCount > 0
          ? (await this.store.listOffers(tripId)).filter((o) => o.status === OfferStatus.PENDING)
          : [];
      // A5 — caduca TODAS las PENDING en UN solo round-trip (winner=null, sin ganador en el barrido),
      // en vez de N×setOfferStatus. Best-effort/cosmético (H7): no toca el board ni el outbox.
      await this.store
        .lapseAndAccept(tripId, null)
        .catch((err) =>
          this.logger.warn(`lapseAndAccept (sweep) trip=${tripId} falló: ${String(err)}`),
        );
      // UN `dispatch.offer_withdrawn` (reason=stale: la ventana cerró sin selección) POR conductor con
      // oferta pendiente → driver-bff lo empuja como `bid:closed` → la app limpia el "esperando" y la card.
      // Idempotente por (trip,driver); sin PII (solo tripId+driverId); best-effort (el poll de 12s respalda).
      await Promise.all(
        pending.map((offer) =>
          this.emit(
            'dispatch.offer_withdrawn',
            tripId,
            { tripId, driverId: offer.driverId, reason: OFFER_WITHDRAWN_REASON.STALE },
            dedupOfferWithdrawn(
              tripId,
              offer.driverId,
              res.windowEpoch !== null ? String(res.windowEpoch) : 'gone',
            ),
          ).catch((err: unknown) =>
            this.logger.warn(
              `offer_withdrawn (stale/sweep) trip=${tripId} driver=${offer.driverId}: ${String(err)}`,
            ),
          ),
        ),
      );
      // La dedupKey se ata a la ventana del board (windowEpoch = expiresAt, devuelto por el Lua). Un
      // reopen abre otra ventana → otro epoch → un no_offers legítimo posterior no queda deduplicado.
      await this.expire(
        tripId,
        reason,
        res.windowEpoch !== null ? String(res.windowEpoch) : `gone`,
      );
      closed++;
    }
    return closed;
  }

  /** Grace (ms) del reconciliador: solo re-emite matches MÁS VIEJOS que esto, dándole al happy-path tiempo
   * de drenarlos con `markMatchEmitted` antes de tocarlos (así solo barre los genuinamente atascados). */
  private static readonly RECONCILE_GRACE_MS = 5_000;

  /**
   * N5 — RECONCILIADOR del residual hard-crash. La acción compensatoria del accept cubre el fallo de la
   * tx de outbox EN PROCESO, pero NO el caso en que el proceso MUERE entre el claim (board→CLOSED_MATCHED)
   * y la commit/marca: ahí el board queda CLOSED_MATCHED, SIN match_found emitido y SIN `matchEmitted`, y
   * el trip queda huérfano en REQUESTED (el watchdog lo EXPIRARÍA por error). Este barrido busca boards
   * CLOSED_MATCHED sin la marca `matchEmitted`, RE-EMITE `offer_accepted`+`match_found` (idempotente por
   * el dedupKey ESTABLE — un re-emit del mismo (trip,driver) dedupea downstream) y setea la marca. Lo
   * invoca el mismo tick del scheduler que `sweepExpired`. Idempotente y acotado.
   */
  async reconcileUnemittedMatches(now = Date.now()): Promise<number> {
    // H8 — SOLO los matched cuyo claim es MÁS VIEJO que el grace (range-read sobre el zset `board:matched`),
    // no todos los matched. Un board recién matcheado (que el happy-path está por drenar con markMatchEmitted)
    // queda FUERA del rango → el reconciliador solo toca los genuinamente atascados (residual hard-crash).
    const pending = await this.store.matchedUnemittedBoards(
      now - OfferBoardService.RECONCILE_GRACE_MS,
    );
    let reemitted = 0;

    // Finding #1 (N+1) — el loop itera BOARDS efímeros (Redis), NO filas DispatchMatch: el
    // `agreedPriceCents` durable NO está en la fila en mano, hay que leerlo de Postgres. El fix previo
    // lo hacía con un `findFirst` POR board → una query por iteración (N+1). En su lugar, lo BATCHEAMOS:
    // UNA sola `findMany` de todas las filas ACCEPTED de los (tripId,driverId) pendientes ANTES del loop,
    // indexada en un Map por `tripId|driverId`. Dentro del loop leemos del Map → CERO queries por iteración.
    // La semántica #11 queda IDÉNTICA: si el Map no tiene precio durable para el (trip,driver) → SKIP
    // (no se fabrica precio, no se marca matchEmitted). El precio NUNCA sale del board/oferta efímeros.
    const accepted = await this.repo.findAcceptedMatches(
      pending
        .filter((b): b is OfferBoard & { acceptedDriverId: string } => b.acceptedDriverId !== undefined)
        .map((b) => ({ tripId: b.tripId, driverId: b.acceptedDriverId })),
    );
    const priceByTripDriver = new Map<string, number | null>(
      accepted.map((m) => [`${m.tripId}|${m.driverId}`, m.agreedPriceCents]),
    );

    for (const board of pending) {
      const driverId = board.acceptedDriverId;
      if (!driverId) {
        // Board CLOSED_MATCHED sin conductor registrado: no podemos reconstruir el match. Marcamos para
        // no re-escanearlo eternamente (caso degenerado; el accept siempre setea acceptedDriverId al claim).
        await this.store.markMatchEmitted(board.tripId).catch(() => undefined);
        continue;
      }
      // Finding #11 — la FUENTE DE VERDAD del precio acordado es la fila DispatchMatch ACCEPTED DURABLE,
      // NO el board/oferta EFÍMEROS de Redis (que pueden haberse evaporado por TTL tras el crash). El bug
      // previo (`chosen?.priceCents ?? board.bidCents`) FABRICABA un precio (caía al bid del board) cuando
      // la oferta efímera ya no existía → trip-service facturaba un fareCents inventado. Acá leemos el
      // precio REAL del Map pre-cargado en lote (sin query por iteración).
      const priceCents = priceByTripDriver.get(`${board.tripId}|${driverId}`);
      if (priceCents === null || priceCents === undefined) {
        // No hay fila ACCEPTED persistida (o sin precio): el reconciliador NO PUEDE recuperar el precio
        // acordado real → NO emite un offer_accepted con un precio fabricado. NO marca matchEmitted (deja
        // que una corrida posterior reintente cuando los datos sean consistentes) y sigue al próximo board.
        this.logger.warn(
          `N5 reconciliador: SKIP trip=${board.tripId} driver=${driverId} — sin DispatchMatch ACCEPTED ` +
            `con agreedPriceCents persistido (no se fabrica precio; se reintenta luego)`,
        );
        domainEventsTotal.inc({
          event: 'dispatch.offer_accepted',
          result: BusinessEventResult.SKIPPED,
        });
        continue;
      }
      try {
        await this.repo.runInTx(async (tx) => {
          const acceptedDedup = dedupOfferAccepted(board.tripId, driverId);
          const accepted = createEnvelope({
            eventType: 'dispatch.offer_accepted',
            producer: 'dispatch-service',
            // H13 — el re-emit del reconciliador estampa el MISMO seq del ciclo del board (idempotente por
            // dedupKey): el offer_accepted reconciliado del crash queda atado a su ciclo, igual que el original.
            payload: {
              tripId: board.tripId,
              driverId,
              priceCents,
              negotiationSeq: board.negotiationSeq,
            },
            dedupKey: acceptedDedup,
          });
          await tx.outboxEvent.create({
            data: {
              aggregateId: board.tripId,
              eventType: accepted.eventType,
              dedupKey: acceptedDedup,
              envelope: accepted as unknown as Prisma.InputJsonValue,
            },
          });
          const matchFoundDedup = dedupMatchFound(board.tripId, driverId);
          const matchFound = createEnvelope({
            eventType: 'dispatch.match_found',
            producer: 'dispatch-service',
            payload: { tripId: board.tripId, driverId, scoreMs: 0 },
            dedupKey: matchFoundDedup,
          });
          await tx.outboxEvent.create({
            data: {
              aggregateId: board.tripId,
              eventType: matchFound.eventType,
              dedupKey: matchFoundDedup,
              envelope: matchFound as unknown as Prisma.InputJsonValue,
            },
          });
        });
      } catch (txErr) {
        // Finding #4a — el evento YA estaba encolado (offer_accepted/match_found con la misma dedupKey
        // estable: una corrida anterior del reconcile, o el accept original, lo insertó). P2002 → NO apilar
        // una segunda fila: tratamos TODO el reconcile de este board como ya-hecho → marcamos matchEmitted
        // y seguimos (idempotente). Cualquier otro error sí burbujea.
        if (!isUniqueViolation(txErr)) throw txErr;
        this.logger.debug(
          `N5 reconciliador: P2002 trip=${board.tripId} driver=${driverId} (evento ya encolado) → ya-hecho`,
        );
      }
      await this.store.markMatchEmitted(board.tripId);
      domainEventsTotal.inc({
        event: 'dispatch.offer_accepted',
        result: BusinessEventResult.RECONCILED,
      });
      domainEventsTotal.inc({
        event: 'dispatch.match_found',
        result: BusinessEventResult.RECONCILED,
      });
      this.logger.warn(
        `N5 reconciliador: re-emitido match_found trip=${board.tripId} driver=${driverId} (residual hard-crash)`,
      );
      reemitted++;
    }
    return reemitted;
  }

  /**
   * Emite `dispatch.no_offers` con una dedupKey ESTABLE atada a la VENTANA del board (`windowEpoch` =
   * board.expiresAt en ms). Así re-emits del MISMO vencimiento (redelivery at-least-once o el barrido
   * re-corriendo el mismo board) dedupean downstream, pero un board REABIERTO (reassign/reopen) abre
   * una ventana nueva → otro epoch → un no_offers legítimo NO queda suprimido. No se keya por tripId
   * solo (eso ahogaría un segundo no_offers tras un reopen).
   */
  private async expire(
    tripId: string,
    reason: 'window_expired' | 'all_lapsed',
    windowEpoch: string,
  ): Promise<void> {
    await this.emit(
      'dispatch.no_offers',
      tripId,
      { tripId, reason },
      dedupNoOffers(tripId, windowEpoch),
    );
    this.logger.log(`board trip=${tripId} EXPIRED (${reason})`);
  }

  /** Encola un evento de dominio en el outbox dentro de su propia transacción (idempotente). */
  private async emit(
    eventType:
      | 'dispatch.offer_made'
      | 'dispatch.no_offers'
      | 'dispatch.offer_withdrawn'
      | 'dispatch.bid_cancelled',
    aggregateId: string,
    payload: Record<string, unknown>,
    dedupKey: string,
  ): Promise<void> {
    const envelope = createEnvelope({
      eventType,
      producer: 'dispatch-service',
      payload,
      dedupKey,
    });
    try {
      await this.repo.runInTx(async (tx) => {
        await tx.outboxEvent.create({
          data: {
            aggregateId,
            eventType: envelope.eventType,
            // Finding #4a — la MISMA dedupKey estable del envelope se persiste en la columna unique → un
            // re-emit del MISMO evento (redelivery/retry) lo rechaza con P2002 (lo tragamos abajo) en vez
            // de apilar una segunda fila en el outbox.
            dedupKey,
            envelope: envelope as unknown as Prisma.InputJsonValue,
          },
        });
      });
    } catch (err) {
      // Re-emit del MISMO evento (misma dedupKey ya insertada): no-op idempotente, no burbujea.
      if (!isUniqueViolation(err)) throw err;
      this.logger.debug(
        `emit ${eventType} dedupKey=${dedupKey}: P2002 (ya encolado) → no-op idempotente`,
      );
      return;
    }
  }
}
