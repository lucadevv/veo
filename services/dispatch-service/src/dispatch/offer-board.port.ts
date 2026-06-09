/**
 * Puertos del OfferBoard (ADR 010 §2, §3.2, §3.3) — la "subasta" efímera de UN viaje.
 *
 * El board y sus ofertas son EFÍMEROS y de alta frecuencia → viven en Redis con TTL (no en el
 * agregado Trip, que lo bloatearía). trip-service sigue dueño del lifecycle durable. El dominio
 * depende de esta interfaz (D de SOLID); en tests se inyecta un fake en memoria con el MISMO contrato.
 */
import type { LatLon } from '@veo/utils';
import type { SpecialRequest, VehicleType } from '@veo/shared-types';

export const OFFER_BOARD_STORE = Symbol('OFFER_BOARD_STORE');

/**
 * Estados del board (ADR 010 §3.2). OPEN es el único en el que se aceptan/colectan ofertas.
 * `as const` (no enum, no literal suelto): un único origen del valor + el tipo derivado homónimo.
 */
export const BoardStatus = {
  OPEN: 'OPEN',
  CLOSED_MATCHED: 'CLOSED_MATCHED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;
export type BoardStatus = (typeof BoardStatus)[keyof typeof BoardStatus];

/** Estados de una oferta de conductor (ADR 010 §3.3). */
export const OfferStatus = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  LAPSED: 'LAPSED',
  WITHDRAWN: 'WITHDRAWN',
  STALE: 'STALE',
} as const;
export type OfferStatus = (typeof OfferStatus)[keyof typeof OfferStatus];

/** Tipo de respuesta del conductor: acepta el precio del bid, o contraoferta uno mayor. */
export const OfferKind = {
  ACCEPT_PRICE: 'ACCEPT_PRICE',
  COUNTER: 'COUNTER',
} as const;
export type OfferKind = (typeof OfferKind)[keyof typeof OfferKind];

/**
 * Resultado del intento ATÓMICO de reclamar el board para una aceptación (compare-and-set).
 * `claimed=true` ⇒ ESTA llamada ganó la carrera (transicionó OPEN→CLOSED_MATCHED, debe emitir el match).
 * `claimed=false` ⇒ otra transición ya cerró el board; `status` es el estado actual (para decidir
 * si fue idempotencia —ya CLOSED_MATCHED— o conflicto). `status=null` ⇒ el board no existe.
 */
export interface ClaimResult {
  claimed: boolean;
  status: BoardStatus | null;
}

/**
 * Resultado del intento ATÓMICO de expirar el board (compare-and-set sobre OPEN + ventana vencida).
 * `expired=true` ⇒ ESTA llamada lo marcó EXPIRED (debe emitir `no_offers`); `offerCount` distingue
 * `window_expired` (0) de `all_lapsed` (>0). `expired=false` ⇒ no se tocó (no OPEN o aún vigente).
 *
 * H8 — `windowEpoch` lo DEVUELVE el script Lua (lee `expiresAt` del board in-script). Así la dedupKey
 * de `no_offers` (`no_offers:${tripId}:${windowEpoch}`) se construye SIN un `getBoard` extra por board
 * por tick (el barrido ya NO pre-lee el board). Es null cuando el board ya no existe (TTL de Redis):
 * el id colgó en el índice y el barrido lo limpia con epoch sentinel `gone`.
 */
export interface ExpireResult {
  expired: boolean;
  offerCount: number;
  /** epoch(ms) de la ventana del board (board.expiresAt), devuelto por el Lua. null si el board no existe. */
  windowEpoch: number | null;
  /**
   * H8 — false ⇒ el board YA NO existe en Redis (expiró por TTL) pero su id colgó en el índice `board:expiry`.
   * El barrido lo usa para limpiar el id colgado (`removeOpenId`) y emitir `window_expired` una vez con
   * epoch sentinel `gone`, sin un `getBoard` extra. true en todos los demás casos (expirado o no-op por raza).
   */
  boardExists: boolean;
}

export interface OfferBoard {
  tripId: string;
  passengerId: string;
  /** Piso de la negociación (céntimos PEN). ACCEPT_PRICE == bidCents; COUNTER > bidCents. */
  bidCents: number;
  vehicleType: VehicleType;
  origin: LatLon;
  /**
   * A3 — celda H3 (a `DISPATCH_H3_RESOLUTION`) del ORIGEN del board, calculada UNA vez al abrirlo. Es la
   * clave del índice inverso `board:cell:<originCell>` (ZSET tripId→expiresAt, H11) que `boardsInCells`
   * consulta: así `listOpenBidsNear` lee SOLO los boards del k-ring del conductor (ZRANGEBYSCORE por celda
   * + MGET de candidatos), no TODOS los OPEN. Los scripts Lua de cierre la leen del JSON para hacer el ZREM
   * del índice de celda en la misma pasada atómica.
   */
  originCell: string;
  status: BoardStatus;
  /** epoch(ms) en que vence la ventana de la puja (openedAt + windowSec). */
  expiresAt: number;
  /**
   * H13 — sello del CICLO de negociación del viaje (eco del `negotiationSeq` MONOTÓNICO que trip-service
   * stampó en `trip.bid_posted`/`trip.reassigning`). Se persiste con el board al abrirlo/re-abrirlo y se
   * ESTAMPA en `dispatch.offer_accepted` (accept + reconciler). trip-service lo exige en el `where` atómico
   * de applyAgreedFare: una redelivery STALE de un offer_accepted de un ciclo viejo (seq menor) no escribe.
   */
  negotiationSeq: number;
  /**
   * BE-2 — solicitudes especiales del pasajero (mascota/equipaje/silla). Se guardan con el board (JSON) y
   * el conductor las VE al listar boards abiertos (`/bids/open`) para decidir si acepta. Vacío = ninguna.
   */
  specialRequests: SpecialRequest[];
  /**
   * N5 — conductor cuya oferta ganó el claim (se graba ATÓMICAMENTE al transicionar a CLOSED_MATCHED).
   * Lo usa el reconciliador para reconstruir el match si el proceso murió antes de emitirlo. Undefined
   * mientras el board está OPEN.
   */
  acceptedDriverId?: string;
  /**
   * N5 — marca de que `match_found` YA se encoló en el outbox para este board CLOSED_MATCHED. Se setea
   * DESPUÉS de la commit durable. El reconciliador re-emite match_found para boards CLOSED_MATCHED con
   * esta marca en false/undefined (residual del crash entre el claim y la commit). Idempotente vía dedupKey.
   */
  matchEmitted?: boolean;
}

export interface Offer {
  tripId: string;
  driverId: string;
  kind: OfferKind;
  priceCents: number;
  etaSeconds: number;
  status: OfferStatus;
  /** epoch(ms) de la última escritura de esta oferta (idempotencia / re-submit). */
  updatedAt: number;
}

/**
 * Campos de una puja OPEN que viajan en DOS salidas: el enrich del ping `dispatch.offered` (broadcast a los
 * conductores elegibles, para que pinten la tarjeta sin refetch) y la vista REST `OpenBidView` (`GET /bids/open`).
 * Hay UN solo derivador (`bidFieldsFromBoard`) del OfferBoard → el evento y el REST NO pueden divergir en qué
 * campos llevan ni cómo se calculan. `expiresAt` no va acá: el ping ya lo lleva como ISO y el REST como epoch(ms).
 */
export interface BidBroadcastFields {
  bidCents: number;
  vehicleType: string;
  originLat: number;
  originLon: number;
  specialRequests: string[];
}

/**
 * Precisión del origen que ve el conductor ANTES de aceptar: ~111m (3 decimales). Need-to-know
 * (Ley 29733 · "movilidad segura"): alcanza para juzgar distancia/conveniencia al pujar, sin exponer
 * el punto EXACTO de recojo (la puerta del pasajero) a los N conductores elegibles que aún no aceptaron.
 * El origen EXACTO se entrega SOLO al conductor ASIGNADO, vía `GET /trips/:id/route` (que verifica
 * ownership). 1 decimal ≈ 11km · 2 ≈ 1.1km · 3 ≈ 111m · 4 ≈ 11m.
 */
const PREBID_ORIGIN_DECIMALS = 3;
function coarsenPreBid(coord: number): number {
  const f = 10 ** PREBID_ORIGIN_DECIMALS;
  return Math.round(coord * f) / f;
}

/** Único mapper OfferBoard → campos de puja. Lo usan el broadcast (evento) y `toOpenBidDto` (REST). */
export function bidFieldsFromBoard(b: OfferBoard): BidBroadcastFields {
  return {
    bidCents: b.bidCents,
    vehicleType: b.vehicleType,
    // Origen ENGROSADO a ~111m pre-aceptación (privacidad). El exacto va por /route al asignarse.
    originLat: coarsenPreBid(b.origin.lat),
    originLon: coarsenPreBid(b.origin.lon),
    specialRequests: b.specialRequests,
  };
}

/**
 * Estado del board tal como lo VE el pasajero en `GET /bids/:tripId/offers`. Suma `GONE` a los estados
 * del board: la key ya NO existe en Redis (expiró por TTL) — el pasajero distingue "puja evaporada" de
 * "puja viva sin ofertas". Los demás valores son los `BoardStatus` reales.
 */
export const ClientBoardStatus = { ...BoardStatus, GONE: 'GONE' } as const;
export type ClientBoardStatus = (typeof ClientBoardStatus)[keyof typeof ClientBoardStatus];

/**
 * FIX contrato — respuesta de `GET /bids/:tripId/offers`: el ESTADO del board + las ofertas. El cliente
 * ya no recibe solo `Offer[]` (no podía distinguir OPEN-sin-ofertas de CANCELLED/EXPIRED/GONE). `offers`
 * sólo trae PENDING con board OPEN; en cualquier otro estado va vacío (no zombies).
 */
export interface OffersView {
  board: {
    status: ClientBoardStatus;
    /** epoch(ms) de vencimiento de la ventana; null si el board ya no existe (GONE). */
    expiresAt: number | null;
  };
  offers: Offer[];
}

/**
 * Almacén Redis del board y sus ofertas. Todas las claves del board comparten el TTL de la ventana
 * (más un margen para el barrido de expiración).
 */
export interface OfferBoardStore {
  /** Crea/reabre el board en estado OPEN con TTL = ttlSeconds. Sobrescribe el board previo del trip. */
  saveBoard(board: OfferBoard, ttlSeconds: number): Promise<void>;
  getBoard(tripId: string): Promise<OfferBoard | null>;
  /** Cambia el estado del board (OPEN → CLOSED_MATCHED | EXPIRED | CANCELLED). No-op si no existe. */
  setBoardStatus(tripId: string, status: BoardStatus): Promise<void>;
  /** Upsert idempotente de una oferta por (tripId, driverId). Re-submit actualiza la misma oferta. */
  saveOffer(offer: Offer, ttlSeconds: number): Promise<void>;
  getOffer(tripId: string, driverId: string): Promise<Offer | null>;
  listOffers(tripId: string): Promise<Offer[]>;
  setOfferStatus(tripId: string, driverId: string, status: OfferStatus): Promise<void>;
  /**
   * Borra ATÓMICAMENTE el HASH completo de ofertas del board (`DEL board:offers:{tripId}`). Lo usa
   * `reopenBoard` para que una ventana RE-ABIERTA arranque con un HASH limpio: ninguna oferta de la
   * ventana anterior (COUNTER a un precio viejo, STALE/LAPSED) sobrevive para ser mal-aceptada. No-op
   * si no hay ofertas.
   */
  clearOffers(tripId: string): Promise<void>;
  /**
   * H8 — tripIds cuya ventana YA VENCIÓ (`ZRANGEBYSCORE board:expiry -inf <nowMs>`). El barrido SOLO
   * recorre los boards DUE (no todos los OPEN): el costo del tick pasa de O(boards) a O(due). Reemplaza
   * al viejo `openBoardIds()` (SMEMBERS-all del SET `board:open`). Puede incluir ids COLGADOS (board
   * vencido por TTL pero su entrada quedó en el zset) — el barrido los limpia con `removeOpenId`.
   */
  dueBoardIds(nowMs: number): Promise<string[]>;
  /**
   * Quita INCONDICIONALMENTE un tripId del índice `board:expiry` (ZREM). A diferencia de
   * `setBoardStatus` (que es no-op si el board ya no existe), esto limpia el id COLGADO cuyo board
   * expiró por TTL de Redis pero quedó en el zset: sin esto el barrido lo re-procesa para siempre.
   */
  removeOpenId(tripId: string): Promise<void>;
  /**
   * Boards OPEN materializados (para listar las pujas abiertas que un conductor puede ofertar). H8 —
   * la membresía sale de `ZRANGEBYSCORE board:expiry <nowMs> +inf` (los NO vencidos aún): solo boards
   * cuya ventana sigue viva, sin SMEMBERS-all. (A3 agregará un cell-index encima; por ahora swap de fuente.)
   */
  listOpenBoards(nowMs: number): Promise<OfferBoard[]>;

  /**
   * A3 — índice INVERSO celda→board (espejo del `candidates()` del hot-index): dadas las celdas H3 del
   * k-ring del conductor, por cada celda `ZRANGEBYSCORE board:cell:<c> <now> +inf` devuelve los tripIds
   * de los boards cuyo ORIGEN cae en esa celda Y cuya ventana sigue viva (score >= now), y un `MGET` trae
   * SOLO esos boards. Así `listOpenBidsNear` deja de cargar TODOS los OPEN del platform-wide para filtrarlos
   * en Node (O(total open boards)) y pasa a O(boards en el k-ring). El filtro restante (vehicleType) corre
   * en Node sobre ese conjunto ACOTADO.
   * H11 — el índice `board:cell:<cell>` es un ZSET scoreado por `expiresAt`: se mantiene con ZADD al
   * abrir/re-abrir (board OPEN) y ZREM al cerrar (claim/expire/cancel/revert), dentro de la misma operación
   * atómica que toca el board; y `boardsInCells` PODA los miembros muertos por TTL (score < now) en cada
   * lectura (ZREMRANGEBYSCORE), de modo que el ZSET queda acotado y no acumula tripIds fantasma.
   */
  boardsInCells(cells: string[]): Promise<OfferBoard[]>;

  // ── Transiciones ATÓMICAS (compare-and-set; cierran las carreras de concurrencia, H1) ──────────

  /**
   * GATE de ganador único de la aceptación (ATÓMICO, una sola pasada Redis vía Lua):
   * IF board existe AND status==='OPEN' → set CLOSED_MATCHED, graba `acceptedDriverId` y `matchEmitted=false`,
   * mueve el id de `board:expiry` a `board:matched` (ZREM→ZADD), y devuelve {claimed:true, status:'CLOSED_MATCHED'}.
   * ELSE no escribe y devuelve {claimed:false, status:<estado actual | null>}.
   * Dos aceptaciones concurrentes de conductores DISTINTOS: SOLO una obtiene claimed=true. El
   * `acceptedDriverId` se graba en el MISMO CAS para que el reconciliador (N5) pueda reconstruir el match.
   * H8 — `claimedAtMs` es el score con que el id entra al zset `board:matched` (ZADD): el reconciliador
   * solo barre los matched MÁS VIEJOS que un grace, dándole tiempo al happy-path a drenarlos.
   */
  claimBoardForAccept(tripId: string, driverId: string, claimedAtMs: number): Promise<ClaimResult>;

  /**
   * N5 — REVERT compensatorio del claim (ATÓMICO): IF board existe AND status==='CLOSED_MATCHED' AND
   * matchEmitted!=true → vuelve a OPEN, limpia `acceptedDriverId`, re-agrega a `board:expiry` (score=expiresAt), quita de
   * `board:matched`. Best-effort: lo llama el accept cuando la tx de outbox falla, para re-abrir la ventana.
   * No revierte un board cuyo match YA se emitió (matchEmitted=true) — ese ya es durable.
   */
  revertClaim(tripId: string): Promise<void>;

  /**
   * N5 — marca `matchEmitted=true` en un board CLOSED_MATCHED y lo saca de `board:matched` (ya no necesita
   * reconciliación). Se llama DESPUÉS de la commit durable del outbox. No-op si el board no existe.
   */
  markMatchEmitted(tripId: string): Promise<void>;

  /**
   * N5 — boards CLOSED_MATCHED cuyo `match_found` NO se emitió aún (índice `board:matched`). El
   * reconciliador los re-procesa para cerrar el residual del crash entre el claim y la commit. H8 — el
   * índice es un zset scoreado por `claimedAtMs`; solo se devuelven los matched cuyo claim es MÁS VIEJO
   * que `olderThanMs` (`ZRANGEBYSCORE board:matched -inf <olderThanMs>`), para no tocar los recién
   * matcheados que el happy-path `markMatchEmitted` está por drenar (solo los genuinamente atascados).
   */
  matchedUnemittedBoards(olderThanMs: number): Promise<OfferBoard[]>;

  /**
   * Expiración ATÓMICA (compare-and-set): IF status==='OPEN' AND expiresAt<=nowMs → set EXPIRED y
   * devuelve {expired:true, offerCount}. ELSE no-op {expired:false, offerCount:0}. Mutuamente excluyente
   * con `claimBoardForAccept`: accept y expire NUNCA pueden ganar ambos (los dos compiten por el mismo
   * CAS sobre OPEN). `offerCount` permite distinguir window_expired/all_lapsed sin una segunda lectura.
   */
  expireIfOpen(tripId: string, nowMs: number): Promise<ExpireResult>;

  /**
   * Cancelación ATÓMICA (compare-and-set, espejo de expireIfOpen): IF status==='OPEN' → set CANCELLED,
   * limpia los índices de barrido y devuelve true. ELSE no-op false. NUNCA pisa un CLOSED_MATCHED/EXPIRED
   * (el read-then-write previo sí podía, en la micro-ventana contra el claim del accept).
   */
  cancelIfOpen(tripId: string): Promise<boolean>;

  /**
   * Submit ATÓMICO de una oferta: IF board existe AND status==='OPEN' → HSET la oferta y devuelve true.
   * ELSE no escribe y devuelve false (cierra el edge "oferta-después-de-cerrar": el check OPEN y el
   * HSET ocurren en la misma pasada, sin ventana entre leer el estado y escribir).
   */
  submitOfferIfOpen(offer: Offer, ttlSeconds: number): Promise<boolean>;

  /**
   * A5 — Flip en LOTE del estado efímero de las ofertas en UN solo round-trip (reemplaza el N×
   * `setOfferStatus` secuencial de accept/sweep, cada uno HGET+HSET). En UNA pasada server-side sobre
   * el HASH de ofertas:
   *  - si `winnerDriverId` != null → esa oferta pasa a ACCEPTED y TODAS las demás PENDING → LAPSED
   *    (caso aceptación: el pasajero eligió un ganador).
   *  - si `winnerDriverId` == null → TODAS las PENDING → LAPSED (caso barrido de expiración, sin ganador).
   * Estos flips son POST-durable-commit / cosméticos (H7/N5): NO tocan el board ni el outbox, solo la
   * vista del pasajero. Best-effort por contrato del caller, pero AQUÍ son un único round-trip.
   * Devuelve el #ofertas modificadas (informativo). No-op si no hay HASH de ofertas.
   */
  lapseAndAccept(tripId: string, winnerDriverId: string | null): Promise<number>;
}

export type { LatLon, VehicleType };
