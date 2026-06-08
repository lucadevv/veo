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
  NotFoundError,
  ValidationError,
  DISPATCH_H3_RESOLUTION,
  BID_MAX_CENTS,
  type LatLon,
} from '@veo/utils';
import { createEnvelope } from '@veo/events';
import { DispatchOutcome, type SpecialRequest, VehicleType } from '@veo/shared-types';
import type { MapsClient } from '@veo/maps';
import { domainEventsTotal } from '@veo/observability';
import { PrismaService } from '../infra/prisma.service';
import { Prisma } from '../generated/prisma';
import { HOT_INDEX, EXCLUSION_REGISTRY, type HotIndex, type ExclusionRegistry } from '../hot-index/hot-index.port';
import { MAPS_CLIENT } from '../ports/maps/maps.module';
import { OFFER_DELIVERY, type OfferDelivery } from './offer-delivery.port';
import {
  OFFER_BOARD_STORE,
  type Offer,
  type OfferBoard,
  type OfferBoardStore,
  type OfferKind,
  type OffersView,
} from './offer-board.port';
import { EligibilityGate } from './eligibility.gate';
import type { Env } from '../config/env.schema';

export interface BidPosted {
  tripId: string;
  passengerId: string;
  bidCents: number;
  vehicleType: VehicleType;
  origin: LatLon;
  windowSec: number;
  /// H13 — ciclo de negociación del viaje (lo guardamos en el board y lo estampamos en offer_accepted).
  negotiationSeq: number;
  /// BE-2 — solicitudes especiales del pasajero (mascota/equipaje/silla); el conductor las ve en el board.
  /// Opcional en la ENTRADA (default [] en openBoard) por compat N-2 con bid_posted previos.
  specialRequests?: SpecialRequest[];
}

export interface Reassigning {
  tripId: string;
  /// Conductor que canceló (se libera del hot-index para que vuelva a ser elegible).
  driverId: string;
  passengerId: string;
  vehicleType: VehicleType;
  origin: LatLon;
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

@Injectable()
export class OfferBoardService {
  private readonly logger = new Logger(OfferBoardService.name);
  private readonly broadcastKRing: number;
  /**
   * Techo de la contraoferta en céntimos PEN (guardarraíl anti-abuso/anti-overflow int4). Un COUNTER
   * se vuelve el fareCents del viaje si el pasajero lo acepta, así que tampoco puede superarlo.
   */
  private readonly bidMaxCents: number;
  /** Margen (s) sobre la ventana para el TTL de Redis, así el barrido alcanza a marcar EXPIRED. */
  private static readonly TTL_MARGIN_SECONDS = 30;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OFFER_BOARD_STORE) private readonly store: OfferBoardStore,
    @Inject(HOT_INDEX) private readonly hotIndex: HotIndex,
    @Inject(EXCLUSION_REGISTRY) private readonly exclusion: ExclusionRegistry,
    @Inject(MAPS_CLIENT) private readonly maps: MapsClient,
    @Inject(OFFER_DELIVERY) private readonly offerDelivery: OfferDelivery,
    private readonly eligibility: EligibilityGate,
    config: ConfigService<Env, true>,
  ) {
    this.broadcastKRing = config.getOrThrow<number>('DISPATCH_MAX_K_RING');
    // Techo de la contraoferta: del env (ajustable por entorno) con fallback al canónico de @veo/utils.
    this.bidMaxCents = config.get<number>('BID_MAX_CENTS') ?? BID_MAX_CENTS;
  }

  // ── Apertura del board: consume trip.bid_posted ──────────────────────────────────────────────

  /** Abre un board OPEN para el viaje y hace broadcast del bid a los conductores elegibles cercanos. */
  async openBoard(bid: BidPosted): Promise<void> {
    const expiresAt = Date.now() + bid.windowSec * 1000;
    const board: OfferBoard = {
      tripId: bid.tripId,
      passengerId: bid.passengerId,
      bidCents: bid.bidCents,
      vehicleType: bid.vehicleType,
      origin: bid.origin,
      // A3 — celda H3 del origen calculada UNA vez acá: alimenta el índice inverso `board:cell:<cell>`
      // que `listOpenBidsNear` consulta por k-ring (en vez de cargar TODOS los boards y filtrar en Node).
      originCell: toH3(bid.origin, DISPATCH_H3_RESOLUTION),
      status: 'OPEN',
      expiresAt,
      // H13 — sella el ciclo de negociación en el board; se estampa en offer_accepted al aceptar.
      negotiationSeq: bid.negotiationSeq,
      // BE-2 — el conductor las ve al listar boards abiertos (/bids/open).
      specialRequests: bid.specialRequests ?? [],
    };
    // N8 — Higiene de ventana (espejo de reopenBoard): PURGA las ofertas de cualquier ventana anterior
    // ANTES de abrir. Un `trip.bid_posted` puede ser un RE-BID (el pasajero subió el bid tras un
    // REASSIGNING/EXPIRED): sin este clear, ofertas PENDING a un precio VIEJO/bajo de la ventana previa
    // sobreviven en el HASH y el pasajero podría aceptar una oferta rancia barata. Tras el clear, el
    // `bidCents` recién abierto es la ÚNICA referencia de precio.
    await this.store.clearOffers(bid.tripId);
    await this.store.saveBoard(board, bid.windowSec + OfferBoardService.TTL_MARGIN_SECONDS);
    this.logger.log(`board abierto trip=${bid.tripId} bid=${bid.bidCents} window=${bid.windowSec}s`);
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
    // Reconstrucción autosuficiente: si quedaba metadato del board previo lo reusamos, pero el caso
    // canónico (board ya expirado por TTL) se rearma SOLO con el payload del evento.
    const existing = await this.store.getBoard(reassign.tripId);
    const origin = existing?.origin ?? reassign.origin;
    const reopened: OfferBoard = {
      tripId: reassign.tripId,
      passengerId: existing?.passengerId ?? reassign.passengerId,
      vehicleType: existing?.vehicleType ?? reassign.vehicleType,
      origin,
      // A3 — re-deriva la celda del origen resuelto (reusa la del board previo si existía, o la del evento).
      originCell: existing?.originCell ?? toH3(origin, DISPATCH_H3_RESOLUTION),
      bidCents: reassign.bidCents,
      status: 'OPEN',
      // Ventana fresca de 60s (default ratificado §9) al MISMO bid (la subida va por rebid → bid_posted).
      expiresAt: Date.now() + 60_000,
      // H13 — el seq SIEMPRE viene del EVENTO (el nuevo ciclo de la reasignación), NUNCA del board previo:
      // re-abrir = ciclo fresco, así el offer_accepted del re-match lleva un seq MAYOR y el offer_accepted
      // STALE del ciclo anterior queda bloqueado en applyAgreedFare (seq menor → where no matchea).
      negotiationSeq: reassign.negotiationSeq,
      // BE-2 — se preservan si el board previo sobrevivió (TTL no expiró). Si se rearma SOLO desde el evento
      // (board ya expirado), quedan []: trip.reassigning aún no las transporta (follow-up). Degradación honesta.
      specialRequests: existing?.specialRequests ?? [],
    };
    // N4 — Higiene de ventana: PURGA las ofertas de la ventana ANTERIOR antes de re-abrir. Sin esto, un
    // COUNTER viejo (a un precio que ya no aplica) o una oferta STALE/LAPSED sobreviven en el HASH y el
    // pasajero podría aceptar un precio rancio de la ventana cerrada. Tras el clear, el bidCents re-abierto
    // es la ÚNICA referencia de precio y no hay ofertas de la ventana previa que mal-aceptar.
    await this.store.clearOffers(reassign.tripId);
    await this.store.saveBoard(reopened, 60 + OfferBoardService.TTL_MARGIN_SECONDS);
    this.logger.log(
      `board ${existing ? 're-abierto' : 'reconstruido'} trip=${reassign.tripId} bid=${reassign.bidCents}`,
    );
    await this.broadcast(reopened);
  }

  /**
   * Broadcast del bid a TODOS los conductores elegibles cercanos (no "el sistema elige uno"):
   * reutiliza el hot-index para encontrar candidatos por celda H3 + tipo de vehículo, filtra los
   * excluidos por pánico, y usa el mecanismo existente de entrega de ofertas (`dispatch.offered`)
   * para notificar a cada candidato que hay un bid disponible al que PUEDE responder.
   */
  private async broadcast(board: OfferBoard): Promise<void> {
    const center = toH3(board.origin, DISPATCH_H3_RESOLUTION);
    const cells = neighbors(center, this.broadcastKRing);
    const locations = await this.hotIndex.candidates(cells);
    const matchingType = locations.filter((l) => l.vehicleType === board.vehicleType);
    const allowedIds = await this.exclusion.filter(matchingType.map((l) => l.driverId));
    const allowed = new Set(allowedIds);
    const candidates = matchingType.filter((l) => allowed.has(l.driverId));

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
      this.logger.warn(`ETA en lote no disponible en broadcast trip=${board.tripId}: ${String(err)}`);
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
          }),
        ).catch((err) => this.logger.warn(`broadcast a ${cand.driverId} falló: ${String(err)}`));
      }),
    );
    this.logger.log(`bid trip=${board.tripId} difundido a ${candidates.length} conductores elegibles`);
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
    if (board.status !== 'OPEN') {
      throw new ConflictError('La puja ya no está abierta', { status: board.status });
    }

    // Capa 3 (service): re-valida elegibilidad contra identity + vehículo. NO basta presencia GPS.
    await this.eligibility.assertEligibleToOffer(input.driverId, board.vehicleType);

    if (input.kind === 'ACCEPT_PRICE' && input.priceCents !== board.bidCents) {
      throw new ValidationError('ACCEPT_PRICE debe igualar el bid', {
        bidCents: board.bidCents,
        priceCents: input.priceCents,
      });
    }
    if (input.kind === 'COUNTER' && input.priceCents <= board.bidCents) {
      throw new ValidationError('COUNTER debe ser mayor al bid', {
        bidCents: board.bidCents,
        priceCents: input.priceCents,
      });
    }
    // Techo de la contraoferta (gate de dominio): un COUNTER pasa a ser el fareCents del viaje si el
    // pasajero lo acepta, así que tampoco puede superar el techo (anti-abuso/anti-overflow int4).
    if (input.kind === 'COUNTER' && input.priceCents > this.bidMaxCents) {
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
      status: 'PENDING',
      updatedAt: Date.now(),
    };
    const ttl = Math.max(1, Math.ceil((board.expiresAt - Date.now()) / 1000)) +
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
      `offer_made:${input.tripId}:${input.driverId}:${input.kind}:${input.priceCents}`,
    );
    return offer;
  }

  // ── Aceptación de una oferta (el pasajero elige UNA) ─────────────────────────────────────────

  /**
   * El pasajero eligió la oferta de `driverId`. Cierra el board (CLOSED_MATCHED), marca esa oferta
   * ACCEPTED y las demás LAPSED, emite `dispatch.offer_accepted` Y `dispatch.match_found` (para que
   * trip materialice ASSIGNED — se mantiene ese contrato). Idempotente: doble-tap → no-op.
   */
  async acceptOffer(tripId: string, driverId: string): Promise<Offer> {
    const board = await this.store.getBoard(tripId);
    if (!board) throw new NotFoundError('Puja no encontrada', { tripId });

    const chosen = await this.store.getOffer(tripId, driverId);
    if (!chosen) throw new NotFoundError('Oferta no encontrada', { tripId, driverId });

    // Doble-tap idempotente del MISMO conductor ya ACEPTADO: cortocircuita ANTES de re-validar.
    // Un conductor que ya quedó asignado a ESTE viaje no necesita seguir AVAILABLE para que el
    // segundo tap del pasajero sea un no-op (si no, una identity flap convertiría el doble-tap en error).
    if (board.status === 'CLOSED_MATCHED' && chosen.status === 'ACCEPTED') {
      return chosen;
    }

    // N4 (defensa en profundidad): SOLO una oferta PENDING es aceptable. Una oferta ya LAPSED (ventana
    // expirada), STALE (conductor que dejó de ser elegible), WITHDRAWN o ACCEPTED-de-otra-ronda NO se
    // puede aceptar — su precio ya no es vinculante. Rechazamos con 409 distinguible para que la UI
    // refresque la lista y el pasajero elija OTRA. Va DESPUÉS del corto-circuito idempotente (un doble-tap
    // del ya-ACCEPTED no llega acá) y ANTES de la re-validación/claim atómico (no tocamos H1/H3).
    if (chosen.status !== 'PENDING') {
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
      chosen.kind === 'ACCEPT_PRICE'
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
      await this.eligibility.assertEligibleToOffer(driverId, board.vehicleType, true);
    } catch {
      await this.store.setOfferStatus(tripId, driverId, 'STALE');
      // BE-3 — la oferta dejó de ser válida con el board OPEN: avisamos al pasajero para que la QUITE al
      // instante (el board sigue abierto para elegir otra). Idempotente por (trip,driver); best-effort: un
      // fallo del emit no debe tapar el ConflictError que el pasajero necesita ver.
      await this.emit(
        'dispatch.offer_withdrawn',
        tripId,
        { tripId, driverId, reason: 'stale' },
        `offer_withdrawn:${tripId}:${driverId}`,
      ).catch((err: unknown) =>
        this.logger.warn(`offer_withdrawn no emitido trip=${tripId} driver=${driverId}: ${String(err)}`),
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

    // A partir de acá ganamos el claim atómico: somos los únicos que materializan el match.
    //
    // N5 — orden DURABLE-PRIMERO: la commit del outbox (la verdad durable del match) ocurre ANTES de
    // tocar el estado EFÍMERO de las ofertas en Redis. Así, si la tx de Postgres FALLA, NINGUNA oferta
    // quedó flipeada y solo hay que revertir el board (CLOSED_MATCHED → OPEN). Sin esto, un fallo de la
    // tx dejaba el board CERRADO sin match_found jamás emitido → trip huérfano en REQUESTED y, peor, el
    // watchdog lo EXPIRAría (resultado equivocado para un viaje que SÍ matcheó). El revert compensatorio
    // re-abre la ventana para que el pasajero reintente el accept (las ofertas siguen ahí, ventana vigente).
    try {
      // offer_accepted + match_found en la MISMA transacción de outbox (FOUNDATION §6).
      await this.prisma.write.$transaction(async (tx) => {
        const accepted = createEnvelope({
          eventType: 'dispatch.offer_accepted',
          producer: 'dispatch-service',
          // H13 — estampa el seq del CICLO del board: trip lo exige en applyAgreedFare para descartar una
          // redelivery de un ciclo viejo (la tarifa rancia del conductor anterior no debe escribirse).
          payload: { tripId, driverId, priceCents: chosen.priceCents, negotiationSeq: board.negotiationSeq },
          dedupKey: `offer_accepted:${tripId}:${driverId}`,
        });
        await tx.outboxEvent.create({
          data: {
            aggregateId: tripId,
            eventType: accepted.eventType,
            envelope: accepted as unknown as Prisma.InputJsonValue,
          },
        });
        const matchFound = createEnvelope({
          eventType: 'dispatch.match_found',
          producer: 'dispatch-service',
          payload: { tripId, driverId, scoreMs: 0 },
          dedupKey: `match_found:${tripId}:${driverId}`,
        });
        await tx.outboxEvent.create({
          data: {
            aggregateId: tripId,
            eventType: matchFound.eventType,
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
        await tx.dispatchMatch.create({
          data: {
            id: uuidv7(),
            tripId,
            driverId,
            score: new Prisma.Decimal(0),
            attempt: 1,
            outcome: DispatchOutcome.ACCEPTED,
            respondedAt: new Date(),
          },
        });
      });
    } catch (txErr) {
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
      throw txErr;
    }

    // La tx durable COMMITEÓ: marcamos el board como match-emitido (flag para el reconciler de N5, que
    // re-emite match_found para boards CLOSED_MATCHED sin esta marca — el residual del crash entre el
    // claim y este punto). Best-effort: si falla, el board sigue CLOSED_MATCHED sin la marca y el
    // reconciler re-emitiría un match_found idempotente (mismo dedupKey) — inofensivo.
    await this.store.markMatchEmitted(tripId).catch((err) =>
      this.logger.warn(`no se pudo marcar matchEmitted trip=${tripId}: ${String(err)}`),
    );

    // Recién AHORA flipeamos el estado efímero de las ofertas (elegida ACCEPTED, resto LAPSED): el match
    // ya es durable, así que estas escrituras son cosméticas (alimentan la vista del pasajero) y un fallo
    // parcial acá NO corrompe el outcome del match. A5 — UN solo round-trip (Lua sobre el HASH) en vez
    // de N×setOfferStatus (cada uno HGET+HSET); best-effort, un fallo acá no afecta el match durable.
    await this.store
      .lapseAndAccept(tripId, driverId)
      .catch((err) => this.logger.warn(`lapseAndAccept trip=${tripId} falló (cosmético): ${String(err)}`));

    // markBusy se mantiene acá (Lote separado): el claim atómico ya garantiza que solo este camino
    // llega hasta acá, así que no hay carrera de doble-markBusy para este board.
    await this.hotIndex.markBusy(driverId);
    domainEventsTotal.inc({ event: 'dispatch.offer_accepted', result: 'published' });
    domainEventsTotal.inc({ event: 'dispatch.match_found', result: 'published' });
    this.logger.log(`board trip=${tripId} CLOSED_MATCHED → driver=${driverId}`);
    return { ...chosen, status: 'ACCEPTED' };
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
    return offers.filter((o) => o.status === 'PENDING');
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
  async getOffersView(tripId: string): Promise<OffersView> {
    const board = await this.store.getBoard(tripId);
    if (!board) {
      // La key del board ya no existe en Redis (TTL): la puja se evaporó. GONE + sin ofertas.
      return { board: { status: 'GONE', expiresAt: null }, offers: [] };
    }
    // Solo un board OPEN expone ofertas elegibles; cualquier otro estado → [] (no zombies).
    const offers =
      board.status === 'OPEN'
        ? (await this.store.listOffers(tripId)).filter((o) => o.status === 'PENDING')
        : [];
    return { board: { status: board.status, expiresAt: board.expiresAt }, offers };
  }

  /**
   * Lista las pujas OPEN que el conductor `driverId` PUEDE ofertar (lado conductor, ADR §6):
   *  1. RE-VALIDA elegibilidad contra identity (online + !suspendido). Si no es elegible → 403.
   *  2. Solo boards cuyo `vehicleType` coincide con el vehículo ACTIVO del conductor (hot-index).
   *  3. Solo boards cuya celda de origen cae dentro del k-ring del conductor (cercanía).
   * El `driverId` lo deriva el driver-bff server-side (nunca un param del cliente). La elegibilidad se
   * enforce ACÁ además del guard del BFF (defensa en profundidad). Devuelve [] si no hay ubicación viva.
   */
  async listOpenBidsNear(driverId: string): Promise<OfferBoard[]> {
    const loc = await this.hotIndex.getLocation(driverId);
    if (!loc) return [];
    // El gate re-valida online/suspendido; si el conductor no es elegible para ofertar → 403.
    await this.eligibility.assertEligibleToOffer(driverId, loc.vehicleType);

    const center = toH3({ lat: loc.lat, lon: loc.lon }, DISPATCH_H3_RESOLUTION);
    const cells = neighbors(center, this.broadcastKRing);
    // A3/H11 — índice inverso celda→board: trae SOLO los boards cuyo ORIGEN cae en el k-ring del conductor
    // (ZRANGEBYSCORE `board:cell:<c>` <now>..+inf + MGET de ESOS candidatos), no TODOS los OPEN del
    // platform-wide. El costo del poll pasa de O(total open boards) a O(boards en el k-ring). El ZSET ya
    // pre-excluye los vencidos por score y poda los muertos por TTL; el filtro en Node es belt-and-suspenders
    // sobre ese conjunto ACOTADO: OPEN + ventana viva + vehículo.
    const now = Date.now();
    const candidates = await this.store.boardsInCells(cells);
    return candidates.filter(
      (b) => b.status === 'OPEN' && b.expiresAt > now && b.vehicleType === loc.vehicleType,
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
  async cancelBoard(tripId: string, opts: { emitClosure?: boolean } = {}): Promise<void> {
    const cancelled = await this.store.cancelIfOpen(tripId);
    if (cancelled) {
      // Higiene: el board se canceló → ninguna oferta de esta ventana debe sobrevivir en el HASH.
      await this.store
        .clearOffers(tripId)
        .catch((err) => this.logger.warn(`clearOffers (cancel) trip=${tripId} falló: ${String(err)}`));
      this.logger.log(`board trip=${tripId} CANCELLED por el pasajero`);
    }
    // Cierre del VIAJE (no solo del board): SIEMPRE que el llamador sea el cancel de la PUJA del pasajero,
    // aunque el board ya no exista (TTL) o ya estuviera cerrado — el trip puede seguir REQUESTED. El evento
    // va por outbox transaccional (no se puede perder); trip-service lo guard-ea por estado (idempotente).
    if (opts.emitClosure) {
      await this.emit(
        'dispatch.bid_cancelled',
        tripId,
        { tripId, reason: 'cancelled_by_passenger' },
        `bid_cancelled:${tripId}`,
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
      // A5 — caduca TODAS las PENDING en UN solo round-trip (winner=null, sin ganador en el barrido),
      // en vez de N×setOfferStatus. Best-effort/cosmético (H7): no toca el board ni el outbox.
      await this.store
        .lapseAndAccept(tripId, null)
        .catch((err) => this.logger.warn(`lapseAndAccept (sweep) trip=${tripId} falló: ${String(err)}`));
      // La dedupKey se ata a la ventana del board (windowEpoch = expiresAt, devuelto por el Lua). Un
      // reopen abre otra ventana → otro epoch → un no_offers legítimo posterior no queda deduplicado.
      await this.expire(tripId, reason, res.windowEpoch !== null ? String(res.windowEpoch) : `gone`);
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
    const pending = await this.store.matchedUnemittedBoards(now - OfferBoardService.RECONCILE_GRACE_MS);
    let reemitted = 0;
    for (const board of pending) {
      const driverId = board.acceptedDriverId;
      if (!driverId) {
        // Board CLOSED_MATCHED sin conductor registrado: no podemos reconstruir el match. Marcamos para
        // no re-escanearlo eternamente (caso degenerado; el accept siempre setea acceptedDriverId al claim).
        await this.store.markMatchEmitted(board.tripId).catch(() => undefined);
        continue;
      }
      const chosen = await this.store.getOffer(board.tripId, driverId);
      const priceCents = chosen?.priceCents ?? board.bidCents;
      await this.prisma.write.$transaction(async (tx) => {
        const accepted = createEnvelope({
          eventType: 'dispatch.offer_accepted',
          producer: 'dispatch-service',
          // H13 — el re-emit del reconciliador estampa el MISMO seq del ciclo del board (idempotente por
          // dedupKey): el offer_accepted reconciliado del crash queda atado a su ciclo, igual que el original.
          payload: { tripId: board.tripId, driverId, priceCents, negotiationSeq: board.negotiationSeq },
          dedupKey: `offer_accepted:${board.tripId}:${driverId}`,
        });
        await tx.outboxEvent.create({
          data: {
            aggregateId: board.tripId,
            eventType: accepted.eventType,
            envelope: accepted as unknown as Prisma.InputJsonValue,
          },
        });
        const matchFound = createEnvelope({
          eventType: 'dispatch.match_found',
          producer: 'dispatch-service',
          payload: { tripId: board.tripId, driverId, scoreMs: 0 },
          dedupKey: `match_found:${board.tripId}:${driverId}`,
        });
        await tx.outboxEvent.create({
          data: {
            aggregateId: board.tripId,
            eventType: matchFound.eventType,
            envelope: matchFound as unknown as Prisma.InputJsonValue,
          },
        });
      });
      await this.store.markMatchEmitted(board.tripId);
      domainEventsTotal.inc({ event: 'dispatch.offer_accepted', result: 'reconciled' });
      domainEventsTotal.inc({ event: 'dispatch.match_found', result: 'reconciled' });
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
      `no_offers:${tripId}:${windowEpoch}`,
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
    await this.prisma.write.$transaction(async (tx) => {
      await tx.outboxEvent.create({
        data: {
          aggregateId,
          eventType: envelope.eventType,
          envelope: envelope as unknown as Prisma.InputJsonValue,
        },
      });
    });
    domainEventsTotal.inc({ event: eventType, result: 'published' });
  }
}
