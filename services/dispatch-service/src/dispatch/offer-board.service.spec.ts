import { describe, it, expect } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { isDomainError, toH3, neighbors, DISPATCH_H3_RESOLUTION } from '@veo/utils';
import {
  VehicleType,
  VehicleSegment,
  SpecialRequest,
  OfferingId,
  DispatchOutcome,
} from '@veo/shared-types';
import { OfferBoardService } from './offer-board.service';
import type { EligibilityGate } from './eligibility.gate';
import type { DispatchRadiusConfigService } from './dispatch-radius-config.service';
import type { DispatchPolicyV2 } from './dispatch-policy';
import { InMemoryHotIndex, InMemoryExclusionRegistry } from '../hot-index/in-memory-hot-index';
import { DriverPool } from './driver-pool';
import type {
  BoardStatus,
  ClaimResult,
  ExpireResult,
  Offer,
  OfferBoard,
  OfferBoardStore,
  OfferStatus,
} from './offer-board.port';
import type { OfferDelivery, DispatchOffer } from './offer-delivery.port';
import type { Env } from '../config/env.schema';

const ORIGIN = { lat: -12.0464, lon: -77.0428 };
const DEST = { lat: -12.0931, lon: -77.0465 };
const DIST_METERS = 4200;
const DUR_SECONDS = 900;
const PASSENGER = 'passenger-1';

/** OfferBoardStore en memoria (mismo contrato que RedisOfferBoardStore). */
class InMemoryOfferBoardStore implements OfferBoardStore {
  private readonly boards = new Map<string, OfferBoard>();
  private readonly offers = new Map<string, Map<string, Offer>>();
  /**
   * H8 — `board:expiry` modelado como SORTED-MAP (tripId → score=expiresAt), espejo del ZSET de Redis.
   * El barrido lee por RANGO (due / no-due), no el set entero. Permite reproducir el id COLGADO.
   */
  private readonly expiryZset = new Map<string, number>();
  /** H8 — `board:matched` como SORTED-MAP (tripId → score=claimedAtMs); índice de reconciliación. */
  private readonly matchedZset = new Map<string, number>();
  /** A3 — `board:cell:<h3>` modelado como Map<cell, Set<tripId>>: índice inverso celda→board. */
  private readonly cellIndex = new Map<string, Set<string>>();

  private cellAdd(cell: string, tripId: string): void {
    let set = this.cellIndex.get(cell);
    if (!set) {
      set = new Set();
      this.cellIndex.set(cell, set);
    }
    set.add(tripId);
  }
  private cellRem(cell: string, tripId: string): void {
    this.cellIndex.get(cell)?.delete(tripId);
  }

  async saveBoard(board: OfferBoard): Promise<void> {
    this.boards.set(board.tripId, { ...board });
    if (board.status === 'OPEN') {
      this.expiryZset.set(board.tripId, board.expiresAt);
      this.cellAdd(board.originCell, board.tripId);
    } else {
      this.expiryZset.delete(board.tripId);
      this.cellRem(board.originCell, board.tripId);
    }
  }
  /** A3 — instrumentación: cuenta los boardsInCells y guarda las celdas pedidas (para PROBAR el k-ring). */
  boardsInCellsCalls = 0;
  readonly boardsInCellsArgs: string[][] = [];
  /** A3 — instrumentación: cuenta listOpenBoards (debe ser 0 en el path de listOpenBidsNear, no all-scan). */
  listOpenBoardsCalls = 0;
  async boardsInCells(cells: string[]): Promise<OfferBoard[]> {
    // Espeja el SUNION + MGET: ids únicos de los SET de celda, luego trae SOLO esos boards (los vivos).
    this.boardsInCellsCalls += 1;
    this.boardsInCellsArgs.push([...cells]);
    const ids = new Set<string>();
    for (const cell of cells) {
      for (const id of this.cellIndex.get(cell) ?? []) ids.add(id);
    }
    const out: OfferBoard[] = [];
    for (const id of ids) {
      const b = this.boards.get(id);
      if (b) out.push({ ...b }); // un id colgado (board ya borrado por TTL) cae acá sin board → se omite
    }
    return out;
  }
  /** H8 — instrumentación: cuenta los GET por tripId para PROBAR que el barrido NO pre-lee boards no-due. */
  readonly getBoardCalls = new Map<string, number>();
  async getBoard(tripId: string): Promise<OfferBoard | null> {
    this.getBoardCalls.set(tripId, (this.getBoardCalls.get(tripId) ?? 0) + 1);
    const b = this.boards.get(tripId);
    return b ? { ...b } : null;
  }
  async setBoardStatus(tripId: string, status: BoardStatus): Promise<void> {
    const b = this.boards.get(tripId);
    if (!b) return; // no-op si el board no existe (espeja RedisOfferBoardStore)
    b.status = status;
    if (status === 'OPEN') {
      this.expiryZset.set(tripId, b.expiresAt);
      this.cellAdd(b.originCell, tripId);
    } else {
      this.expiryZset.delete(tripId);
      this.cellRem(b.originCell, tripId);
    }
  }
  /** Helper de test: borra el board pero DEJA su id en el expiry-zset (id colgado tras TTL de Redis). */
  __danglingDrop(tripId: string, expiresAt: number): void {
    const b = this.boards.get(tripId);
    if (b) this.cellRem(b.originCell, tripId);
    this.boards.delete(tripId);
    this.expiryZset.set(tripId, expiresAt);
  }
  async saveOffer(offer: Offer): Promise<void> {
    const m = this.offers.get(offer.tripId) ?? new Map<string, Offer>();
    m.set(offer.driverId, { ...offer });
    this.offers.set(offer.tripId, m);
  }
  async getOffer(tripId: string, driverId: string): Promise<Offer | null> {
    const o = this.offers.get(tripId)?.get(driverId);
    return o ? { ...o } : null;
  }
  async listOffers(tripId: string): Promise<Offer[]> {
    return [...(this.offers.get(tripId)?.values() ?? [])].map((o) => ({ ...o }));
  }
  /** A5 — cuenta los setOfferStatus single para PROBAR que accept/sweep ya NO hacen N flips secuenciales. */
  setOfferStatusCalls = 0;
  async setOfferStatus(tripId: string, driverId: string, status: OfferStatus): Promise<void> {
    this.setOfferStatusCalls += 1;
    const o = this.offers.get(tripId)?.get(driverId);
    if (o) o.status = status;
  }
  /** A5 — cuenta los lapseAndAccept (debe ser 1 por accept/sweep: UN round-trip, no N). */
  lapseAndAcceptCalls = 0;
  async lapseAndAccept(tripId: string, winnerDriverId: string | null): Promise<number> {
    // Espeja el Lua: en una pasada, winner→ACCEPTED y el resto PENDING→LAPSED (sin tocar muertas).
    this.lapseAndAcceptCalls += 1;
    const m = this.offers.get(tripId);
    if (!m) return 0;
    let changed = 0;
    for (const [driverId, offer] of m) {
      let newStatus: OfferStatus | null = null;
      if (winnerDriverId !== null && driverId === winnerDriverId) newStatus = 'ACCEPTED';
      else if (offer.status === 'PENDING') newStatus = 'LAPSED';
      if (newStatus !== null && offer.status !== newStatus) {
        offer.status = newStatus;
        offer.updatedAt = Date.now();
        changed += 1;
      }
    }
    return changed;
  }
  /** Borra TODO el HASH de ofertas del trip (espeja `DEL board:offers:{tripId}`). No-op si no existe. */
  async clearOffers(tripId: string): Promise<void> {
    this.offers.delete(tripId);
  }
  async dueBoardIds(nowMs: number): Promise<string[]> {
    // H8 — espeja `ZRANGEBYSCORE board:expiry -inf <now>`: SOLO los ids con score(expiresAt) <= now
    // (vencidos). Los no vencidos NO se devuelven → el barrido nunca los toca.
    return [...this.expiryZset.entries()].filter(([, score]) => score <= nowMs).map(([id]) => id);
  }
  async removeOpenId(tripId: string): Promise<void> {
    this.expiryZset.delete(tripId);
  }
  async listOpenBoards(nowMs: number): Promise<OfferBoard[]> {
    this.listOpenBoardsCalls += 1;
    // H8 — espeja `ZRANGEBYSCORE board:expiry (<now> +inf`: solo boards aún NO vencidos (score > now).
    const ids = [...this.expiryZset.entries()]
      .filter(([, score]) => score > nowMs)
      .map(([id]) => id);
    return ids
      .map((id) => this.boards.get(id))
      .filter((b): b is OfferBoard => b?.status === 'OPEN')
      .map((b) => ({ ...b }));
  }

  // ── Transiciones atómicas. En JS single-thread, una función async SIN await interno corre como
  //    una sección crítica indivisible (no cede el event loop), así que estos son atómico-equivalentes
  //    al CAS de Lua: NO usar await dentro del read-check-write. ──────────────────────────────────
  async claimBoardForAccept(
    tripId: string,
    driverId: string,
    claimedAtMs: number,
  ): Promise<ClaimResult> {
    const b = this.boards.get(tripId);
    if (!b) return { claimed: false, status: null };
    if (b.status !== 'OPEN') return { claimed: false, status: b.status };
    b.status = 'CLOSED_MATCHED';
    b.acceptedDriverId = driverId; // grabado en el MISMO CAS (N5)
    b.matchEmitted = false;
    this.expiryZset.delete(tripId); // ZREM board:expiry como en el script Lua de Redis
    this.matchedZset.set(tripId, claimedAtMs); // ZADD board:matched <claimedAtMs> (N5/H8)
    this.cellRem(b.originCell, tripId); // A3 — SREM del cell-index (el board deja de ser OPEN)
    return { claimed: true, status: 'CLOSED_MATCHED' };
  }
  async revertClaim(tripId: string): Promise<void> {
    const b = this.boards.get(tripId);
    if (b?.status !== 'CLOSED_MATCHED' || b.matchEmitted === true) return;
    b.status = 'OPEN';
    delete b.acceptedDriverId;
    delete b.matchEmitted;
    this.expiryZset.set(tripId, b.expiresAt); // re-ZADD board:expiry con score=expiresAt
    this.matchedZset.delete(tripId);
    this.cellAdd(b.originCell, tripId); // A3 — SADD de vuelta al cell-index (vuelve a ser OPEN)
  }
  async markMatchEmitted(tripId: string): Promise<void> {
    const b = this.boards.get(tripId);
    this.matchedZset.delete(tripId);
    if (b) b.matchEmitted = true;
  }
  async matchedUnemittedBoards(olderThanMs: number): Promise<OfferBoard[]> {
    // H8 — espeja `ZRANGEBYSCORE board:matched -inf <olderThanMs>`: solo los matched cuyo claim
    // (score=claimedAtMs) es MÁS VIEJO que el grace. Los recién matcheados quedan fuera del rango.
    const out: OfferBoard[] = [];
    for (const [tripId, claimedAt] of this.matchedZset) {
      if (claimedAt > olderThanMs) continue;
      const b = this.boards.get(tripId);
      if (!b) continue;
      if (b.status === 'CLOSED_MATCHED' && b.matchEmitted !== true) out.push({ ...b });
    }
    return out;
  }
  /**
   * Sink de la fila DispatchMatch persistida (lo provee el test desde la OutboxSpy). El crash real deja
   * el board CLOSED_MATCHED en Redis Y la fila ACCEPTED ya COMMITEADA en Postgres (Finding #11: el
   * reconciliador lee el precio de ahí). __crashedMatch siembra AMBOS lados para reproducir el residual fiel.
   */
  persistMatch?: (tripId: string, driverId: string, agreedPriceCents: number | null) => void;
  /**
   * Helper de test: simula el residual hard-crash — board CLOSED_MATCHED sin marca, en el matched-zset.
   * `agreedPriceCents` (default 700, el bid de openBoard) siembra TAMBIÉN la fila ACCEPTED persistida que
   * el reconciliador necesita para recuperar el precio (sin fabricarlo). Pasar `null` simula el caso #11
   * donde NO hay precio recuperable (o no pasar el sink → no se siembra fila).
   */
  __crashedMatch(
    tripId: string,
    driverId: string,
    claimedAtMs = 0,
    agreedPriceCents: number | null = 700,
  ): void {
    const b = this.boards.get(tripId);
    if (!b) return;
    b.status = 'CLOSED_MATCHED';
    b.acceptedDriverId = driverId;
    b.matchEmitted = false;
    this.expiryZset.delete(tripId);
    this.matchedZset.set(tripId, claimedAtMs);
    this.cellRem(b.originCell, tripId);
    if (agreedPriceCents !== null) this.persistMatch?.(tripId, driverId, agreedPriceCents);
  }
  async expireIfOpen(tripId: string, nowMs: number): Promise<ExpireResult> {
    const b = this.boards.get(tripId);
    // Board no existe (id colgado): boardExists=false para que el barrido limpie el zset (espeja Lua {-2}).
    if (!b) return { expired: false, offerCount: 0, windowEpoch: null, boardExists: false };
    if (b.status !== 'OPEN' || b.expiresAt > nowMs) {
      return { expired: false, offerCount: 0, windowEpoch: null, boardExists: true };
    }
    b.status = 'EXPIRED';
    this.expiryZset.delete(tripId); // ZREM como en el script Lua de Redis
    this.cellRem(b.originCell, tripId); // A3 — SREM del cell-index (el board deja de ser OPEN)
    // H8 — el windowEpoch (expiresAt) lo devuelve el "Lua", NO un getBoard del barrido.
    return {
      expired: true,
      offerCount: this.offers.get(tripId)?.size ?? 0,
      windowEpoch: b.expiresAt,
      boardExists: true,
    };
  }
  async submitOfferIfOpen(offer: Offer): Promise<boolean> {
    const b = this.boards.get(offer.tripId);
    if (b?.status !== 'OPEN') return false;
    const m = this.offers.get(offer.tripId) ?? new Map<string, Offer>();
    m.set(offer.driverId, { ...offer });
    this.offers.set(offer.tripId, m);
    return true;
  }
  async cancelIfOpen(tripId: string): Promise<boolean> {
    const b = this.boards.get(tripId);
    // CAS OPEN→CANCELLED (espeja el Lua): no-op si no existe o ya cerró (nunca pisa CLOSED_MATCHED).
    if (b?.status !== 'OPEN') return false;
    b.status = 'CANCELLED';
    this.expiryZset.delete(tripId);
    this.cellRem(b.originCell, tripId);
    return true;
  }
}

/** Captura los eventos encolados en el outbox (prisma.write.$transaction → outboxEvent.create). */
interface CapturedEvent {
  eventType: string;
  payload: unknown;
  aggregateId: string;
  dedupKey: string;
}

/** Fila DispatchMatch persistida (subconjunto que el reconciliador lee: tripId, driverId, outcome, precio). */
interface PersistedMatch {
  tripId: string;
  driverId: string;
  outcome: string;
  agreedPriceCents: number | null;
}

/**
 * Error con la SHAPE de Prisma.PrismaClientKnownRequestError que el service detecta (instanceof + .code).
 * El service usa `err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'`. Para que el
 * instanceof matchee sin acoplar el test al runtime de Prisma, construimos la clase REAL via prototype.
 */
async function makeP2002(): Promise<Error> {
  const { Prisma } = await import('../generated/prisma');
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

class OutboxSpy {
  readonly events: CapturedEvent[] = [];
  /** Filas DispatchMatch persistidas en la tx (Finding #11: fuente de verdad del precio acordado). */
  readonly matches: PersistedMatch[] = [];
  /** Finding #4a — dedupKeys ya vistas: un re-insert de la MISMA clave lanza P2002 (swallow path). */
  private readonly seenDedupKeys = new Set<string>();
  /** Si está activo, la PRÓXIMA tx de outbox LANZA (simula un fallo de Postgres) y se auto-desactiva. */
  failNextTx = false;
  /** Helper de test: siembra una fila ACCEPTED persistida (lo que acceptOffer haría en la tx real). */
  seedMatch(tripId: string, driverId: string, agreedPriceCents: number | null): void {
    this.matches.push({ tripId, driverId, outcome: 'ACCEPTED', agreedPriceCents });
  }
  get prisma(): {
    write: { $transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> };
    read: { dispatchMatch: { findMany: (args: unknown) => Promise<PersistedMatch[]> } };
  } {
    let p2002: Error | null = null;
    const tx = {
      outboxEvent: {
        create: async ({
          data,
        }: {
          data: {
            eventType: string;
            aggregateId: string;
            dedupKey?: string;
            envelope: { payload: unknown; dedupKey: string };
          };
        }) => {
          // Finding #4a — la columna dedupKey y la del envelope deben COINCIDIR (mismo origen estable).
          const key = data.dedupKey ?? data.envelope.dedupKey;
          if (key != null) {
            if (this.seenDedupKeys.has(key)) {
              // Re-insert de la MISMA clave estable → P2002 (ejercita el swallow idempotente del service).
              p2002 ??= await makeP2002();
              throw p2002;
            }
            this.seenDedupKeys.add(key);
          }
          this.events.push({
            eventType: data.eventType,
            aggregateId: data.aggregateId,
            payload: data.envelope.payload,
            dedupKey: data.dedupKey ?? data.envelope.dedupKey,
          });
        },
      },
      // acceptOffer persiste el RECORD de asignación (DispatchMatch) en la MISMA tx que el outbox, con su
      // agreedPriceCents (Finding #11). Lo registramos para que el reconciliador pueda leerlo via read.
      dispatchMatch: {
        create: async ({ data }: { data: PersistedMatch }) => {
          this.matches.push({
            tripId: data.tripId,
            driverId: data.driverId,
            outcome: data.outcome,
            agreedPriceCents: data.agreedPriceCents ?? null,
          });
          return undefined;
        },
      },
    };
    return {
      write: {
        $transaction: async (fn) => {
          if (this.failNextTx) {
            this.failNextTx = false;
            // Emula el rollback de Postgres: la tx falla → NINGÚN evento/match queda encolado.
            const eventsBefore = this.events.length;
            const matchesBefore = this.matches.length;
            const keysBefore = new Set(this.seenDedupKeys);
            try {
              await fn(tx);
            } finally {
              this.events.length = eventsBefore; // descarta lo "escrito" en la tx abortada
              this.matches.length = matchesBefore;
              this.seenDedupKeys.clear();
              for (const k of keysBefore) this.seenDedupKeys.add(k);
            }
            throw new Error('simulated outbox tx failure');
          }
          return fn(tx);
        },
      },
      // Finding #11 + Finding #1 (N+1) — el reconciliador lee el precio acordado de las filas DispatchMatch
      // ACCEPTED persistidas. Ahora en UN solo `findMany` (batch) por los (tripId,driverId) pendientes en vez
      // de un `findFirst` por board. El where trae `outcome` + `OR:[{tripId,driverId},...]`; devolvemos TODAS
      // las filas ACCEPTED que matchean alguno de esos pares (mismo subconjunto que antes resolvía N findFirst).
      read: {
        dispatchMatch: {
          findMany: async (args: unknown) => {
            const where = (
              args as {
                where: { outcome: string; OR?: { tripId: string; driverId: string }[] };
              }
            ).where;
            const pairs = where.OR ?? [];
            return this.matches.filter(
              (m) =>
                m.outcome === where.outcome &&
                pairs.some((p) => p.tripId === m.tripId && p.driverId === m.driverId),
            );
          },
        },
      },
    };
  }
  byType(t: string): CapturedEvent[] {
    return this.events.filter((e) => e.eventType === t);
  }
}

class CollectingDelivery implements OfferDelivery {
  readonly delivered: DispatchOffer[] = [];
  async deliver(offer: DispatchOffer): Promise<void> {
    this.delivered.push(offer);
  }
}

/** Gate controlable por test: por defecto todos elegibles; `block(driverId)` los vuelve no elegibles. */
class FakeGate {
  private readonly blocked = new Set<string>();
  constructor(private readonly eligibleByDefault: boolean) {}
  block(driverId: string): void {
    this.blocked.add(driverId);
  }
  async assertEligibleToOffer(driverId: string): Promise<void> {
    if (!this.eligibleByDefault || this.blocked.has(driverId)) {
      const { ForbiddenError } = await import('@veo/utils');
      throw new ForbiddenError('no elegible', { driverId });
    }
  }
}

/**
 * MapsClient fake (subconjunto que usa OfferBoardService): `eta` single + `etaBatch` en lote.
 * `etaBatchCalls` cuenta las invocaciones para PROBAR que el broadcast llama UNA sola vez (A1), no N.
 */
class FakeMaps {
  etaBatchCalls = 0;
  /** longitudes de los lotes pedidos (para verificar el zip 1:1 con los candidatos). */
  readonly etaBatchSizes: number[] = [];
  constructor(private readonly etaSeconds = 120) {}
  async eta(): Promise<number> {
    return this.etaSeconds;
  }
  async etaBatch(origins: readonly { lat: number; lon: number }[]): Promise<number[]> {
    this.etaBatchCalls += 1;
    this.etaBatchSizes.push(origins.length);
    return origins.map(() => this.etaSeconds);
  }
}

function makeService(opts: {
  store: InMemoryOfferBoardStore;
  hotIndex: InMemoryHotIndex;
  exclusion: InMemoryExclusionRegistry;
  outbox: OutboxSpy;
  delivery: CollectingDelivery;
  gate: FakeGate;
  maps?: FakeMaps;
  // Holder MUTABLE de las ventanas: dispatch es la AUTORIDAD de la ventana (openBoard + reopenBoard leen
  // getWindows() en runtime, ya no bid.windowSec). Los tests conducen la ventana cambiando este objeto
  // (p.ej. bidWindowSec=1 para "vencido", 600 para "vivo") en vez del param advisory de openBoard.
  windows: { offerTimeoutMs: number; bidWindowSec: number };
  // Holder MUTABLE de la política de despacho (feature-flag). Default v1 → el broadcast usa matchKRing
  // (comportamiento actual). Un test lo pasa a v2 para ejercitar radiusKmToKRing(broadcastRadiusKm).
  policy: { policyVersion: 'v1' | 'v2'; v2: DispatchPolicyV2 | null };
}): OfferBoardService {
  const config = new ConfigService<Env, true>({ DISPATCH_MAX_K_RING: 2 } as Partial<Env> as Env);
  const gate = opts.gate as unknown as EligibilityGate;
  const driverPool = new DriverPool(opts.hotIndex, opts.exclusion, new InMemoryExclusionRegistry());
  // Fake de la config de radios/ventanas/política: el broadcast/listOpenBidsNear leen `matchKRing` (2
  // preserva el k-ring que estos tests asertan) en v1, o radiusKmToKRing(broadcastRadiusKm) en v2.
  // getWindows()/getPolicy() leen los holders mutables → los tests controlan ventana y política.
  const radiusConfig = {
    getKRings: async () => ({ nearbyKRing: 1, matchKRing: 2 }),
    getWindows: async () => ({ ...opts.windows }),
    getPolicy: async () => ({ policyVersion: opts.policy.policyVersion, v2: opts.policy.v2 }),
  } as unknown as DispatchRadiusConfigService;
  // §10 — el repo (puerto Prisma del board) abre la tx y batchea la lectura de matches ACCEPTED; el cuerpo
  // transaccional (outbox + record) sigue en el service. Delega al doble de la OutboxSpy (misma semántica).
  const repo = {
    runInTx: (fn: (tx: unknown) => Promise<unknown>) => opts.outbox.prisma.write.$transaction(fn),
    findAcceptedMatches: (pairs: { tripId: string; driverId: string }[]) =>
      opts.outbox.prisma.read.dispatchMatch.findMany({
        where: { outcome: DispatchOutcome.ACCEPTED, OR: pairs },
      }),
  };
  return new OfferBoardService(
    repo as never,
    opts.store,
    opts.hotIndex,
    driverPool,
    (opts.maps ?? new FakeMaps()) as never,
    opts.delivery,
    gate,
    radiusConfig,
    config,
  );
}

interface Ctx {
  svc: OfferBoardService;
  store: InMemoryOfferBoardStore;
  hotIndex: InMemoryHotIndex;
  outbox: OutboxSpy;
  delivery: CollectingDelivery;
  gate: FakeGate;
  maps: FakeMaps;
  /** Ventanas de runtime (autoridad de dispatch): mutable para que un test fije la ventana vigente. */
  windows: { offerTimeoutMs: number; bidWindowSec: number };
  /** Política de despacho (feature-flag): mutable para que un test fije v1/v2. */
  policy: { policyVersion: 'v1' | 'v2'; v2: DispatchPolicyV2 | null };
}

async function ctx(eligible = true): Promise<Ctx> {
  const store = new InMemoryOfferBoardStore();
  const hotIndex = new InMemoryHotIndex();
  const exclusion = new InMemoryExclusionRegistry();
  const outbox = new OutboxSpy();
  const delivery = new CollectingDelivery();
  const gate = new FakeGate(eligible);
  const maps = new FakeMaps();
  // Default 60s (como el default histórico de la ventana de puja); cada test lo ajusta si lo necesita.
  const windows = { offerTimeoutMs: 12_000, bidWindowSec: 60 };
  // Default v1 (comportamiento actual); los tests de v2 lo cambian.
  const policy: Ctx['policy'] = { policyVersion: 'v1', v2: null };
  // Wire del sink de matches persistidos: __crashedMatch siembra la fila ACCEPTED en la OutboxSpy (el
  // crash real deja la fila committeada en Postgres) para que el reconciliador recupere el precio (Finding #11).
  store.persistMatch = (tripId, driverId, price) => outbox.seedMatch(tripId, driverId, price);
  const svc = makeService({ store, hotIndex, exclusion, outbox, delivery, gate, maps, windows, policy });
  return { svc, store, hotIndex, outbox, delivery, gate, maps, windows, policy };
}

async function openBoard(
  c: Ctx,
  windowSec = 60,
  bidCents = 700,
  negotiationSeq = 1,
): Promise<string> {
  const tripId = 'trip-1';
  // La ventana es autoridad de dispatch: conducimos la del board por el holder de runtime (no por el
  // param advisory). Así los tests que pasaban windowSec=1/600 siguen fijando esa ventana efectiva.
  c.windows.bidWindowSec = windowSec;
  await c.svc.openBoard({
    tripId,
    passengerId: PASSENGER,
    bidCents,
    vehicleType: VehicleType.CAR,
    origin: ORIGIN,
    destination: DEST,
    distanceMeters: DIST_METERS,
    durationSeconds: DUR_SECONDS,
    windowSec,
    negotiationSeq,
  });
  return tripId;
}

describe('OfferBoardService — ciclo de vida del board (ADR 010)', () => {
  it('openBoard abre OPEN y difunde a conductores elegibles cercanos', async () => {
    const c = await ctx();
    const cell = toH3(ORIGIN, DISPATCH_H3_RESOLUTION);
    await c.hotIndex.seed('d-near', ORIGIN.lat, ORIGIN.lon, cell, VehicleType.CAR);
    await c.hotIndex.seed('d-moto', ORIGIN.lat, ORIGIN.lon, cell, VehicleType.MOTO); // no coincide
    const tripId = await openBoard(c);

    const board = await c.store.getBoard(tripId);
    expect(board?.status).toBe('OPEN');
    // Difunde solo al CAR (filtro por vehículo del bid); el MOTO no recibe el broadcast.
    expect(c.delivery.delivered.map((d) => d.driverId)).toEqual(['d-near']);
  });

  it('A1: broadcast llama maps.etaBatch UNA sola vez (no N) y zipea las etas a cada candidato', async () => {
    const c = await ctx();
    const cell = toH3(ORIGIN, DISPATCH_H3_RESOLUTION);
    // 3 candidatos CAR elegibles cercanos → ANTES = 3 awaits de eta; AHORA = 1 etaBatch.
    await c.hotIndex.seed('d1', ORIGIN.lat, ORIGIN.lon, cell, VehicleType.CAR);
    await c.hotIndex.seed('d2', ORIGIN.lat, ORIGIN.lon, cell, VehicleType.CAR);
    await c.hotIndex.seed('d3', ORIGIN.lat, ORIGIN.lon, cell, VehicleType.CAR);
    await openBoard(c);

    // UNA sola invocación al lote, con TODOS los candidatos (no N llamadas single).
    expect(c.maps.etaBatchCalls).toBe(1);
    expect(c.maps.etaBatchSizes).toEqual([3]);
    // Cada candidato recibió su entrega con la eta del lote (zip 1:1).
    expect(c.delivery.delivered.map((d) => d.driverId).sort()).toEqual(['d1', 'd2', 'd3']);
    expect(c.delivery.delivered.every((d) => d.etaSeconds === 120)).toBe(true);
  });

  it('L2: el broadcast ENRIQUECE el ping con el bid del board (monto/origen/vehículo/specials)', async () => {
    const c = await ctx();
    const cell = toH3(ORIGIN, DISPATCH_H3_RESOLUTION);
    await c.hotIndex.seed('d-near', ORIGIN.lat, ORIGIN.lon, cell, VehicleType.CAR);
    // Board con special request: el conductor debe poder pintar la tarjeta de puja SIN refetch.
    await c.svc.openBoard({
      tripId: 'trip-1',
      passengerId: PASSENGER,
      bidCents: 850,
      vehicleType: VehicleType.CAR,
      origin: ORIGIN,
      destination: DEST,
      distanceMeters: DIST_METERS,
      durationSeconds: DUR_SECONDS,
      windowSec: 60,
      negotiationSeq: 1,
      specialRequests: [SpecialRequest.PET],
    });

    expect(c.delivery.delivered).toHaveLength(1);
    // El enrich deriva del MISMO OfferBoard que `GET /bids/open` (bidFieldsFromBoard) → no divergen.
    // El origen viaja ENGROSADO a ~111m (3 decimales) pre-aceptación: -12.0464→-12.046, -77.0428→-77.043
    // (privacidad · Ley 29733). El exacto se entrega al asignarse vía /trips/:id/route.
    expect(c.delivery.delivered[0]?.bid).toEqual({
      bidCents: 850,
      vehicleType: VehicleType.CAR,
      originLat: -12.046,
      originLon: -77.043,
      // El board conserva destino + distancia/duración (del tripBidPosted enriquecido): el conductor pinta
      // pickup→destino + distancia en la tarjeta de puja sin refetch. El destino también viaja ENGROSADO a ~111m.
      destLat: -12.093,
      destLon: -77.046,
      distanceMeters: DIST_METERS,
      durationSeconds: DUR_SECONDS,
      // Ola 2B — sin waypoints en el bid → 0 (el derivador SIEMPRE emite el conteo, nunca undefined).
      waypointCount: 0,
      specialRequests: [SpecialRequest.PET],
    });
  });

  it('Ola 2B: el board persiste SOLO el CONTEO de waypoints y el enrich lo difunde ("+N paradas")', async () => {
    const c = await ctx();
    const cell = toH3(ORIGIN, DISPATCH_H3_RESOLUTION);
    await c.hotIndex.seed('d-near', ORIGIN.lat, ORIGIN.lon, cell, VehicleType.CAR);
    await c.svc.openBoard({
      tripId: 'trip-1',
      passengerId: PASSENGER,
      bidCents: 850,
      vehicleType: VehicleType.CAR,
      origin: ORIGIN,
      destination: DEST,
      distanceMeters: DIST_METERS,
      durationSeconds: DUR_SECONDS,
      windowSec: 60,
      negotiationSeq: 1,
      // Dos paradas intermedias: al conductor le llega el CONTEO, jamás estas coordenadas (Ley 29733).
      waypoints: [
        { lat: -12.05, lon: -77.04 },
        { lat: -12.07, lon: -77.05 },
      ],
    });

    // `bid!`: el enrich es SIEMPRE presente en el broadcast de PUJA (solo FIXED lo deja undefined).
    const delivered = c.delivery.delivered[0]!.bid!;
    expect(delivered.waypointCount).toBe(2);
    // Minimización de datos: NINGUNA coordenada de parada cruza en el broadcast.
    expect('waypoints' in delivered).toBe(false);
    // Y el poll (la otra fuente de la card) lo derive del MISMO board.
    const [nearby] = await c.svc.listOpenBidsNear('d-near');
    expect(nearby?.board.waypointCount).toBe(2);
  });

  it('submitOffer ACCEPT_PRICE válido → PENDING + emite dispatch.offer_made', async () => {
    const c = await ctx();
    const cell = toH3(ORIGIN, DISPATCH_H3_RESOLUTION);
    await c.hotIndex.seed('d1', ORIGIN.lat, ORIGIN.lon, cell, VehicleType.CAR);
    const tripId = await openBoard(c, 60, 700);

    const offer = await c.svc.submitOffer({
      driverId: 'd1',
      tripId,
      kind: 'ACCEPT_PRICE',
      priceCents: 700,
    });
    expect(offer.status).toBe('PENDING');
    expect(c.outbox.byType('dispatch.offer_made')).toHaveLength(1);
  });

  it('Fase B · withdrawDriverOffers marca STALE la oferta OPEN del conductor + emite offer_withdrawn', async () => {
    const c = await ctx();
    const cell = toH3(ORIGIN, DISPATCH_H3_RESOLUTION);
    await c.hotIndex.seed('d1', ORIGIN.lat, ORIGIN.lon, cell, VehicleType.CAR);
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });

    const withdrawn = await c.svc.withdrawDriverOffers('d1');
    expect(withdrawn).toBe(1);
    expect((await c.store.getOffer(tripId, 'd1'))?.status).toBe('STALE');
    const events = c.outbox.byType('dispatch.offer_withdrawn');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ tripId, driverId: 'd1', reason: 'stale' });
  });

  it('Fase B · withdrawDriverOffers de un conductor sin ofertas abiertas es no-op (0)', async () => {
    const c = await ctx();
    await openBoard(c, 60, 700);
    expect(await c.svc.withdrawDriverOffers('d-sin-ofertas')).toBe(0);
    expect(c.outbox.byType('dispatch.offer_withdrawn')).toHaveLength(0);
  });

  it('submitOffer COUNTER debe superar el bid (<=bid → ValidationError)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    let caught: unknown;
    try {
      await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'COUNTER', priceCents: 700 });
    } catch (e) {
      caught = e;
    }
    expect(isDomainError(caught) && caught.httpStatus === 400).toBe(true);
  });

  it('submitOffer COUNTER por encima del techo → ValidationError (anti-overflow int4)', async () => {
    const c = await ctx();
    // bid 700; un COUNTER desbocado supera el bid PERO también el techo BID_MAX_CENTS (999_900):
    // pasaría a ser el fareCents si el pasajero lo acepta → debe rechazarse.
    const tripId = await openBoard(c, 60, 700);
    let caught: unknown;
    try {
      await c.svc.submitOffer({
        driverId: 'd1',
        tripId,
        kind: 'COUNTER',
        priceCents: 9_999_999_999,
      });
    } catch (e) {
      caught = e;
    }
    expect(isDomainError(caught) && caught.httpStatus === 400).toBe(true);
  });

  it('submitOffer ACCEPT_PRICE con precio != bid → ValidationError', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    let caught: unknown;
    try {
      await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 800 });
    } catch (e) {
      caught = e;
    }
    expect(isDomainError(caught) && caught.httpStatus === 400).toBe(true);
  });

  it('submitOffer con gate NO elegible → 403 (no se almacena la oferta)', async () => {
    const c = await ctx(false);
    const tripId = await openBoard(c);
    let caught: unknown;
    try {
      await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });
    } catch (e) {
      caught = e;
    }
    expect(isDomainError(caught) && caught.httpStatus === 403).toBe(true);
    expect(await c.store.listOffers(tripId)).toHaveLength(0);
  });

  it('submitOffer es idempotente por (tripId, driverId): re-submit actualiza la misma oferta', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'COUNTER', priceCents: 900 });
    const offers = await c.store.listOffers(tripId);
    expect(offers).toHaveLength(1);
    expect(offers[0]?.kind).toBe('COUNTER');
    expect(offers[0]?.priceCents).toBe(900);
  });

  it('acceptOffer → CLOSED_MATCHED, elegida ACCEPTED, otras LAPSED, emite offer_accepted + match_found', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });
    await c.svc.submitOffer({ driverId: 'd2', tripId, kind: 'COUNTER', priceCents: 900 });

    await c.svc.acceptOffer(tripId, 'd1', PASSENGER);

    const board = await c.store.getBoard(tripId);
    expect(board?.status).toBe('CLOSED_MATCHED');
    const offers = await c.store.listOffers(tripId);
    expect(offers.find((o) => o.driverId === 'd1')?.status).toBe('ACCEPTED');
    expect(offers.find((o) => o.driverId === 'd2')?.status).toBe('LAPSED');
    expect(c.outbox.byType('dispatch.offer_accepted')).toHaveLength(1);
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(1);
    // H13 — el offer_accepted lleva ESTAMPADO el negotiationSeq del board (ciclo 1 de openBoard).
    expect(
      (c.outbox.byType('dispatch.offer_accepted')[0]?.payload as { negotiationSeq: number })
        .negotiationSeq,
    ).toBe(1);
  });

  it('H13: reopenBoard estampa el NUEVO seq del ciclo en el offer_accepted (no el del ciclo viejo)', async () => {
    const c = await ctx();
    // Ciclo 1 abierto (seq=1). El conductor canceló → reopenBoard con el seq del NUEVO ciclo (2).
    const tripId = await openBoard(c, 60, 700, 1);
    await c.svc.reopenBoard({
      tripId,
      driverId: 'drv-cancel',
      passengerId: PASSENGER,
      vehicleType: VehicleType.CAR,
      origin: ORIGIN,
      destination: DEST,
      distanceMeters: DIST_METERS,
      durationSeconds: DUR_SECONDS,
      bidCents: 900,
      negotiationSeq: 2,
    });
    // El board re-abierto lleva el seq del ciclo 2.
    expect((await c.store.getBoard(tripId))?.negotiationSeq).toBe(2);
    await c.svc.submitOffer({ driverId: 'd9', tripId, kind: 'COUNTER', priceCents: 1100 });
    await c.svc.acceptOffer(tripId, 'd9', PASSENGER);
    // El offer_accepted del re-match lleva el seq=2 (no el 1 del ciclo viejo): trip lo usa para descartar
    // un offer_accepted STALE del ciclo 1 que se redelivere tarde.
    expect(
      (c.outbox.byType('dispatch.offer_accepted')[0]?.payload as { negotiationSeq: number })
        .negotiationSeq,
    ).toBe(2);
  });

  it('A5: acceptOffer flipea las ofertas en UN solo round-trip (lapseAndAccept, no N setOfferStatus)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });
    await c.svc.submitOffer({ driverId: 'd2', tripId, kind: 'COUNTER', priceCents: 900 });
    await c.svc.submitOffer({ driverId: 'd3', tripId, kind: 'COUNTER', priceCents: 950 });

    c.store.setOfferStatusCalls = 0;
    c.store.lapseAndAcceptCalls = 0;
    await c.svc.acceptOffer(tripId, 'd1', PASSENGER);

    // UN único round-trip de flip (no 3 setOfferStatus secuenciales).
    expect(c.store.lapseAndAcceptCalls).toBe(1);
    expect(c.store.setOfferStatusCalls).toBe(0);
    // El estado quedó correcto: ganador ACCEPTED, resto LAPSED.
    const offers = await c.store.listOffers(tripId);
    expect(offers.find((o) => o.driverId === 'd1')?.status).toBe('ACCEPTED');
    expect(offers.find((o) => o.driverId === 'd2')?.status).toBe('LAPSED');
    expect(offers.find((o) => o.driverId === 'd3')?.status).toBe('LAPSED');
    // Y sigue emitiendo UN solo match.
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(1);
  });

  it('A5: sweepExpired caduca todas las PENDING en UN round-trip (lapseAndAccept winner=null)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 1, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });
    await c.svc.submitOffer({ driverId: 'd2', tripId, kind: 'COUNTER', priceCents: 900 });

    c.store.setOfferStatusCalls = 0;
    c.store.lapseAndAcceptCalls = 0;
    await c.svc.sweepExpired(Date.now() + 5_000);

    expect(c.store.lapseAndAcceptCalls).toBe(1);
    expect(c.store.setOfferStatusCalls).toBe(0);
    const offers = await c.store.listOffers(tripId);
    expect(offers.every((o) => o.status === 'LAPSED')).toBe(true);
    expect((c.outbox.byType('dispatch.no_offers')[0]?.payload as { reason: string }).reason).toBe(
      'all_lapsed',
    );
  });

  it('acceptOffer es idempotente (doble-tap del pasajero → no re-emite)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });
    await c.svc.acceptOffer(tripId, 'd1', PASSENGER);
    await c.svc.acceptOffer(tripId, 'd1', PASSENGER); // segundo tap
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(1);
  });

  it('acceptOffer RE-VALIDA al conductor: si quedó NO elegible → 409 driver_unavailable, board sigue OPEN, sin match', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });

    // El conductor se fue offline / tomó otro viaje DESPUÉS de ofertar.
    c.gate.block('d1');

    let caught: unknown;
    try {
      await c.svc.acceptOffer(tripId, 'd1', PASSENGER);
    } catch (e) {
      caught = e;
    }
    // Conflicto con código distinguible para la UI.
    expect(isDomainError(caught) && caught.httpStatus === 409).toBe(true);
    expect((caught as { details?: { reason?: string } }).details?.reason).toBe(
      'driver_unavailable',
    );
    // El board NO se reclamó: sigue OPEN para que el pasajero elija otra oferta.
    expect((await c.store.getBoard(tripId))?.status).toBe('OPEN');
    // La oferta rancia queda STALE.
    expect((await c.store.getOffer(tripId, 'd1'))?.status).toBe('STALE');
    // No se emitió ningún match.
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(0);
    expect(c.outbox.byType('dispatch.offer_accepted')).toHaveLength(0);
  });

  it('A2 (ADR-021): 2 boards distintos, MISMO conductor → el 2º accept se rechaza (driver_claimed) y su board vuelve a OPEN', async () => {
    const c = await ctx();
    // Board A (trip-1, vía openBoard) + Board B (trip-2, a mano) con el MISMO conductor ofertando en AMBOS.
    const tripA = await openBoard(c, 60, 700);
    const tripB = 'trip-2';
    c.windows.bidWindowSec = 60;
    await c.svc.openBoard({
      tripId: tripB,
      passengerId: 'pax-2',
      bidCents: 700,
      vehicleType: VehicleType.CAR,
      origin: ORIGIN,
      destination: DEST,
      distanceMeters: DIST_METERS,
      durationSeconds: DUR_SECONDS,
      windowSec: 60,
      negotiationSeq: 1,
    });
    await c.svc.submitOffer({
      driverId: 'd1',
      tripId: tripA,
      kind: 'ACCEPT_PRICE',
      priceCents: 700,
    });
    await c.svc.submitOffer({
      driverId: 'd1',
      tripId: tripB,
      kind: 'ACCEPT_PRICE',
      priceCents: 700,
    });

    // 1er accept: gana el board Y reclama a d1 de forma síncrona (tryClaimDriver).
    await c.svc.acceptOffer(tripA, 'd1', PASSENGER);
    expect((await c.store.getBoard(tripA))?.status).toBe('CLOSED_MATCHED');

    // 2º accept del MISMO conductor en OTRO board (otro pasajero): el claim per-driver FALLA → 409.
    let caught: unknown;
    try {
      await c.svc.acceptOffer(tripB, 'd1', 'pax-2');
    } catch (e) {
      caught = e;
    }
    expect(isDomainError(caught) && caught.httpStatus === 409).toBe(true);
    expect((caught as { details?: { reason?: string } }).details?.reason).toBe('driver_claimed');
    // Board B se REVIERTE a OPEN (compensación existente) para que su pasajero elija otro conductor.
    expect((await c.store.getBoard(tripB))?.status).toBe('OPEN');
    // UN solo match materializado (el de tripA): tripB no emitió match_found (claim perdido antes de la tx).
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(1);
  });

  it('A2 (ADR-021): tras liberar al conductor (releaseClaim), su oferta en OTRO board YA se puede aceptar', async () => {
    const c = await ctx();
    const tripA = await openBoard(c, 60, 700);
    const tripB = 'trip-2';
    c.windows.bidWindowSec = 60;
    await c.svc.openBoard({
      tripId: tripB,
      passengerId: 'pax-2',
      bidCents: 700,
      vehicleType: VehicleType.CAR,
      origin: ORIGIN,
      destination: DEST,
      distanceMeters: DIST_METERS,
      durationSeconds: DUR_SECONDS,
      windowSec: 60,
      negotiationSeq: 1,
    });
    await c.svc.submitOffer({
      driverId: 'd1',
      tripId: tripA,
      kind: 'ACCEPT_PRICE',
      priceCents: 700,
    });
    await c.svc.submitOffer({
      driverId: 'd1',
      tripId: tripB,
      kind: 'ACCEPT_PRICE',
      priceCents: 700,
    });
    await c.svc.acceptOffer(tripA, 'd1', PASSENGER);

    // El viaje A terminó → releaseClaim suelta el claim per-conductor (lo que hace dispatch.releaseDriver).
    await c.hotIndex.releaseClaim('d1');

    // Ahora d1 vuelve a ser reclamable: el accept del board B tiene éxito.
    await c.svc.acceptOffer(tripB, 'd1', 'pax-2');
    expect((await c.store.getBoard(tripB))?.status).toBe('CLOSED_MATCHED');
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(2);
  });

  it('acceptOffer con conductor aún elegible → sigue funcionando (un solo match)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });

    await c.svc.acceptOffer(tripId, 'd1', PASSENGER);

    expect((await c.store.getBoard(tripId))?.status).toBe('CLOSED_MATCHED');
    expect((await c.store.getOffer(tripId, 'd1'))?.status).toBe('ACCEPTED');
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(1);
  });

  it('acceptOffer rancia deja elegir OTRA oferta: tras el 409, el pasajero acepta a un conductor elegible', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });
    await c.svc.submitOffer({ driverId: 'd2', tripId, kind: 'COUNTER', priceCents: 900 });

    c.gate.block('d1');
    await expect(c.svc.acceptOffer(tripId, 'd1', PASSENGER)).rejects.toThrow();
    // El board quedó OPEN → el pasajero elige a d2 (elegible) y SÍ matchea.
    await c.svc.acceptOffer(tripId, 'd2', PASSENGER);
    expect((await c.store.getBoard(tripId))?.status).toBe('CLOSED_MATCHED');
    expect((await c.store.getOffer(tripId, 'd2'))?.status).toBe('ACCEPTED');
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(1);
  });

  it('N8: openBoard PURGA las ofertas de la ventana anterior (un bid_posted/re-bid arranca con HASH limpio)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    // Una oferta de la ventana ANTERIOR a un precio viejo/barato.
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });
    expect(await c.store.getOffer(tripId, 'd1')).not.toBeNull();

    // El pasajero SUBE el bid → trip-service re-emite bid_posted → openBoard de nuevo (mismo trip).
    await openBoard(c, 60, 900);

    // La oferta vieja a 700 ya NO existe: el clear la barrió. El bid nuevo (900) es la única referencia.
    expect(await c.store.getOffer(tripId, 'd1')).toBeNull();
    expect((await c.store.getBoard(tripId))?.bidCents).toBe(900);
  });

  it('N8: acceptOffer rechaza una oferta de PRECIO rancio tras un re-bid (offer_price_stale)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });

    // El pasajero sube el bid a 900 PERO (simulando un edge donde la oferta vieja sobrevivió al clear:
    // p.ej. board re-guardado sin pasar por openBoard) re-inyectamos la oferta vieja de 700 y subimos
    // el bid del board a 900. El defensive accept-guard debe rechazar el precio rancio.
    const board = await c.store.getBoard(tripId);
    if (board) await c.store.saveBoard({ ...board, bidCents: 900 });
    await c.store.saveOffer({
      tripId,
      driverId: 'd1',
      kind: 'ACCEPT_PRICE',
      priceCents: 700,
      etaSeconds: 0,
      status: 'PENDING',
      updatedAt: Date.now(),
    });

    let caught: unknown;
    try {
      await c.svc.acceptOffer(tripId, 'd1', PASSENGER);
    } catch (e) {
      caught = e;
    }
    expect(isDomainError(caught) && caught.httpStatus === 409).toBe(true);
    expect((caught as { details?: { reason?: string } }).details?.reason).toBe('offer_price_stale');
    // El board NO se cerró: el pasajero puede elegir otra (o que d1 re-oferte al bid nuevo).
    expect((await c.store.getBoard(tripId))?.status).toBe('OPEN');
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(0);
  });

  it('N8: acceptOffer ACEPTA una oferta cuyo precio IGUALA el bid actual (no rancia)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 900);
    // d1 oferta al bid VIGENTE (900) → precio válido → matchea.
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 900 });
    await c.svc.acceptOffer(tripId, 'd1', PASSENGER);
    expect((await c.store.getBoard(tripId))?.status).toBe('CLOSED_MATCHED');
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(1);
  });

  it('acceptOffer doble-tap idempotente NO falla aunque el conductor quede no elegible tras el match', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });
    await c.svc.acceptOffer(tripId, 'd1', PASSENGER); // matchea (d1 elegible)

    // d1 pasa a ON_TRIP (ya no AVAILABLE) tras quedar asignado — el segundo tap NO debe romper.
    c.gate.block('d1');
    const again = await c.svc.acceptOffer(tripId, 'd1', PASSENGER);
    expect(again.status).toBe('ACCEPTED');
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(1);
  });

  it('cancelBoard → CANCELLED', async () => {
    const c = await ctx();
    const tripId = await openBoard(c);
    await c.svc.cancelBoard(tripId, PASSENGER);
    expect((await c.store.getBoard(tripId))?.status).toBe('CANCELLED');
  });

  it('FIX cancel-puja: cancelBoard(emitClosure) emite dispatch.bid_cancelled + purga ofertas', async () => {
    const c = await ctx();
    const tripId = await openBoard(c);
    await c.svc.submitOffer({ tripId, driverId: 'd1', kind: 'ACCEPT_PRICE', priceCents: 700 });
    expect(await c.store.listOffers(tripId)).toHaveLength(1);

    await c.svc.cancelBoard(tripId, PASSENGER, { emitClosure: true });

    expect((await c.store.getBoard(tripId))?.status).toBe('CANCELLED');
    // Limpieza: el HASH de ofertas se purga al cancelar (no zombies hasta el TTL).
    expect(await c.store.listOffers(tripId)).toHaveLength(0);
    // Evento de CIERRE del viaje por outbox (transaccional, no se puede perder).
    const ev = c.outbox.byType('dispatch.bid_cancelled');
    expect(ev).toHaveLength(1);
    expect(ev[0]?.aggregateId).toBe(tripId);
    expect((ev[0]?.payload as { reason: string }).reason).toBe('cancelled_by_passenger');
    expect(ev[0]?.dedupKey).toBe(`bid_cancelled:${tripId}`);
  });

  it('GAP #1 cancel-puja: NOTIFICA a los conductores que ofertaron con offer_withdrawn(cancelled)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c);
    await c.svc.submitOffer({ tripId, driverId: 'd1', kind: 'ACCEPT_PRICE', priceCents: 700 });
    await c.svc.submitOffer({ tripId, driverId: 'd2', kind: 'ACCEPT_PRICE', priceCents: 700 });

    await c.svc.cancelBoard(tripId, PASSENGER, { emitClosure: true });

    // Un offer_withdrawn(cancelled) POR conductor con oferta viva → driver-bff lo empuja como bid:closed →
    // la BidCard muere reactiva (sin esperar el poll de 12s). Sin esto la card quedaba "abierta".
    const withdrawn = c.outbox.byType('dispatch.offer_withdrawn');
    expect(withdrawn).toHaveLength(2);
    expect(withdrawn.every((e) => (e.payload as { reason: string }).reason === 'cancelled')).toBe(
      true,
    );
    expect(
      new Set(withdrawn.map((e) => (e.payload as { driverId: string }).driverId)),
    ).toEqual(new Set(['d1', 'd2']));
  });

  it('GAP #1 cancel-puja: board SIN ofertas → no emite offer_withdrawn (nadie que notificar)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c);
    await c.svc.cancelBoard(tripId, PASSENGER, { emitClosure: true });
    expect(c.outbox.byType('dispatch.offer_withdrawn')).toHaveLength(0);
  });

  it('FIX cancel-puja: SIN emitClosure (camino trip.cancelled) NO emite bid_cancelled (anti-bucle)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c);
    await c.svc.cancelBoard(tripId, PASSENGER); // default emitClosure=false
    expect((await c.store.getBoard(tripId))?.status).toBe('CANCELLED');
    expect(c.outbox.byType('dispatch.bid_cancelled')).toHaveLength(0);
  });

  it('FIX cancel-puja: board YA evaporado por TTL → igual emite bid_cancelled (cierra el trip zombie)', async () => {
    const c = await ctx();
    // Nunca se abrió board (o ya murió por TTL): getBoard = null, cancelIfOpen = false. Aun así el VIAJE
    // del pasajero puede seguir REQUESTED y debe cerrarse → emitimos el cierre igual (caso "cancelo a 95s").
    const tripId = 'trip-gone';
    await c.svc.cancelBoard(tripId, PASSENGER, { emitClosure: true });
    expect(c.outbox.byType('dispatch.bid_cancelled')).toHaveLength(1);
  });

  it('FIX cancel-puja: cancel repetido (emitClosure) es idempotente (re-emite mismo dedupKey, trip ya cerrará)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c);
    await c.svc.cancelBoard(tripId, PASSENGER, { emitClosure: true });
    await c.svc.cancelBoard(tripId, PASSENGER, { emitClosure: true }); // segundo cancel: board ya CANCELLED
    // Cada llamada emite el cierre con el MISMO dedupKey → trip-service dedupea/guard-ea por estado.
    const ev = c.outbox.byType('dispatch.bid_cancelled');
    expect(ev.every((e) => e.dedupKey === `bid_cancelled:${tripId}`)).toBe(true);
    // El board sigue CANCELLED (el segundo CAS fue no-op, nunca lo resucitó).
    expect((await c.store.getBoard(tripId))?.status).toBe('CANCELLED');
  });

  it('BF · cancelBoard NUNCA pisa un board ya matcheado (CAS no-op sobre CLOSED_MATCHED)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c);
    await c.svc.submitOffer({ tripId, driverId: 'd1', kind: 'ACCEPT_PRICE', priceCents: 700 });
    await c.svc.acceptOffer(tripId, 'd1', PASSENGER); // el claim cierra el board: CLOSED_MATCHED
    await c.svc.cancelBoard(tripId, PASSENGER); // carrera cancel-tras-accept: debe ser no-op
    expect((await c.store.getBoard(tripId))?.status).toBe('CLOSED_MATCHED');
  });

  it('sweepExpired sin ofertas → EXPIRED + no_offers{window_expired}', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 1, 700);
    const closed = await c.svc.sweepExpired(Date.now() + 5_000);
    expect(closed).toBe(1);
    expect((await c.store.getBoard(tripId))?.status).toBe('EXPIRED');
    const noOffers = c.outbox.byType('dispatch.no_offers');
    expect(noOffers).toHaveLength(1);
    expect((noOffers[0]?.payload as { reason: string }).reason).toBe('window_expired');
  });

  it('sweepExpired con ofertas no aceptadas → EXPIRED + no_offers{all_lapsed} + ofertas LAPSED', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 1, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });
    await c.svc.sweepExpired(Date.now() + 5_000);
    const noOffers = c.outbox.byType('dispatch.no_offers');
    expect((noOffers[0]?.payload as { reason: string }).reason).toBe('all_lapsed');
    expect((await c.store.listOffers(tripId))[0]?.status).toBe('LAPSED');
  });

  it('sweepExpired NO cierra boards aún vigentes', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    const closed = await c.svc.sweepExpired(Date.now()); // ventana de 60s, no venció
    expect(closed).toBe(0);
    expect((await c.store.getBoard(tripId))?.status).toBe('OPEN');
  });

  // ── H8: barrido due-only sobre sorted-set ─────────────────────────────────────────────────────
  it('H8: sweepExpired SOLO procesa boards DUE — un board no vencido NO se toca ni se GET-ea', async () => {
    const c = await ctx();
    // Un board que YA venció (ventana 1s) y otro que sigue vigente (600s). La ventana efectiva la fija el
    // holder de runtime (autoridad de dispatch) antes de cada open; windowSec del payload es advisory.
    const dueTrip = 'trip-1';
    c.windows.bidWindowSec = 1;
    await c.svc.openBoard({
      tripId: dueTrip,
      passengerId: PASSENGER,
      bidCents: 700,
      vehicleType: VehicleType.CAR,
      origin: ORIGIN,
      destination: DEST,
      distanceMeters: DIST_METERS,
      durationSeconds: DUR_SECONDS,
      windowSec: 1,
      negotiationSeq: 1,
    });
    const liveTrip = 'trip-live';
    c.windows.bidWindowSec = 600;
    await c.svc.openBoard({
      tripId: liveTrip,
      passengerId: PASSENGER,
      bidCents: 700,
      vehicleType: VehicleType.CAR,
      origin: ORIGIN,
      destination: DEST,
      distanceMeters: DIST_METERS,
      durationSeconds: DUR_SECONDS,
      windowSec: 600,
      negotiationSeq: 1,
    });

    const now = Date.now() + 5_000; // vencido el de 1s, NO el de 600s
    // El rango DUE devuelve SOLO el vencido (prueba O(due), no O(total)).
    expect(await c.store.dueBoardIds(now)).toEqual([dueTrip]);

    c.store.getBoardCalls.clear();
    const closed = await c.svc.sweepExpired(now);

    // Solo el vencido se expiró y emitió no_offers.
    expect(closed).toBe(1);
    // El barrido NO hizo NINGÚN getBoard: ni del vencido (el epoch vino del Lua, no de un getBoard
    // pre-CAS) ni del vigente (que ni siquiera entró al rango DUE). Se chequea ANTES de cualquier
    // getBoard de aserto para no contaminar el contador.
    expect(c.store.getBoardCalls.get(liveTrip) ?? 0).toBe(0);
    expect(c.store.getBoardCalls.get(dueTrip) ?? 0).toBe(0);
    expect(c.store.getBoardCalls.size).toBe(0);
    // Ahora sí verificamos el estado final (estos getBoard son de los asertos, ya contados aparte).
    expect((await c.store.getBoard(dueTrip))?.status).toBe('EXPIRED');
    expect((await c.store.getBoard(liveTrip))?.status).toBe('OPEN');
  });

  it('H8: el windowEpoch de la dedupKey de no_offers viene del Lua (sin getBoard pre-CAS)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 1, 700);
    const expiresAt = (await c.store.getBoard(tripId))?.expiresAt;

    c.store.getBoardCalls.clear();
    await c.svc.sweepExpired(Date.now() + 5_000);

    // El barrido NO pre-leyó el board: el epoch de la dedupKey salió del expireIfOpen (Lua), no de un getBoard.
    expect(c.store.getBoardCalls.get(tripId) ?? 0).toBe(0);
    const noOffers = c.outbox.byType('dispatch.no_offers');
    expect(noOffers).toHaveLength(1);
    expect(noOffers[0]?.dedupKey).toBe(`no_offers:${tripId}:${expiresAt}`);
  });

  it('H8: con N boards NO-due, el barrido NO emite GETs por board (descubre nada-vence con un range-read)', async () => {
    const c = await ctx();
    // 50 boards vigentes (no vencidos) + ninguno due. Ventana 600s vía el holder de runtime.
    c.windows.bidWindowSec = 600;
    for (let i = 0; i < 50; i++) {
      await c.svc.openBoard({
        tripId: `live-${i}`,
        passengerId: PASSENGER,
        bidCents: 700,
        vehicleType: VehicleType.CAR,
        origin: ORIGIN,
        destination: DEST,
        distanceMeters: DIST_METERS,
        durationSeconds: DUR_SECONDS,
        windowSec: 600,
        negotiationSeq: 1,
      });
    }
    c.store.getBoardCalls.clear();
    const closed = await c.svc.sweepExpired(Date.now()); // nada venció

    expect(closed).toBe(0);
    // O(due)=O(0): ni un solo getBoard ni expire por los 50 no-due (antes era O(N) GETs).
    expect(c.store.getBoardCalls.size).toBe(0);
    expect(await c.store.dueBoardIds(Date.now())).toEqual([]);
  });

  it('H8: listOpenBoards/listOpenBidsNear devuelve los boards OPEN no-vencidos (membresía por rango)', async () => {
    const c = await ctx();
    const cell = toH3(ORIGIN, DISPATCH_H3_RESOLUTION);
    await c.hotIndex.seed('d1', ORIGIN.lat, ORIGIN.lon, cell, VehicleType.CAR);
    const tripId = await openBoard(c, 600, 700); // board OPEN, ventana viva
    // Aparece en la membresía (no vencido) y lo ve listOpenBidsNear.
    expect((await c.store.listOpenBoards(Date.now())).map((b) => b.tripId)).toEqual([tripId]);
    expect((await c.svc.listOpenBidsNear('d1')).map((n) => n.board.tripId)).toEqual([tripId]);
  });

  it('no_offers usa dedupKey ESTABLE por ventana: re-emit del MISMO vencimiento → idempotencia DEL PRODUCTOR (#4a)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 1, 700);
    const board = await c.store.getBoard(tripId);
    const expiresAt = board?.expiresAt;

    await c.svc.sweepExpired(Date.now() + 5_000);
    const first = c.outbox.byType('dispatch.no_offers');
    expect(first).toHaveLength(1);
    expect(first[0]?.dedupKey).toBe(`no_offers:${tripId}:${expiresAt}`);

    // Re-emitir el MISMO board/ventana (redelivery / re-corrida del barrido del mismo expiry): la dedupKey
    // estable ya está en la columna UNIQUE → el re-insert lanza P2002 y el productor lo TRAGA como no-op
    // (Finding #4a). Antes downstream dedupeaba una segunda fila; ahora el productor ya NO la apila.
    await c.svc['expire'](tripId, 'window_expired', String(expiresAt));
    const second = c.outbox.byType('dispatch.no_offers');
    expect(second).toHaveLength(1); // sigue en UNA: la idempotencia del productor suprimió el re-insert
    expect(second[0]?.dedupKey).toBe(first[0]?.dedupKey);
  });

  it('no_offers de un board REABIERTO usa dedupKey DISTINTA (ventana nueva → no se suprime)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 1, 700);
    const firstExpiry = (await c.store.getBoard(tripId))?.expiresAt;
    await c.svc.sweepExpired(Date.now() + 5_000); // primer no_offers

    // Reabrir (reassign/reopen) abre una ventana fresca → otro expiresAt → otra dedupKey. Fijamos 60s en el
    // holder de runtime (reopen lee getWindows()): distinta de la de 1s del open Y vencible en el +120s de abajo.
    c.windows.bidWindowSec = 60;
    await c.svc.reopenBoard({
      tripId,
      driverId: 'drv-cancel',
      passengerId: PASSENGER,
      vehicleType: VehicleType.CAR,
      origin: ORIGIN,
      destination: DEST,
      distanceMeters: DIST_METERS,
      durationSeconds: DUR_SECONDS,
      bidCents: 900,
      negotiationSeq: 1,
    });
    const secondExpiry = (await c.store.getBoard(tripId))?.expiresAt;
    await c.svc.sweepExpired(Date.now() + 120_000); // segundo no_offers, ventana nueva vencida

    const noOffers = c.outbox.byType('dispatch.no_offers');
    expect(noOffers).toHaveLength(2);
    expect(noOffers[0]?.dedupKey).toBe(`no_offers:${tripId}:${firstExpiry}`);
    expect(noOffers[1]?.dedupKey).toBe(`no_offers:${tripId}:${secondExpiry}`);
    // El segundo no_offers (legítimo, tras reopen) NO comparte clave con el primero → no se deduplica.
    expect(noOffers[1]?.dedupKey).not.toBe(noOffers[0]?.dedupKey);
  });

  it('offer_made usa dedupKey ESTABLE por (trip,driver,kind,price)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });
    const made = c.outbox.byType('dispatch.offer_made');
    expect(made).toHaveLength(1);
    expect(made[0]?.dedupKey).toBe(`offer_made:${tripId}:d1:ACCEPT_PRICE:700`);

    // Una contraoferta GENUINAMENTE distinta (otro kind/precio) → dedupKey nueva (emite, no se ahoga).
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'COUNTER', priceCents: 900 });
    const made2 = c.outbox.byType('dispatch.offer_made');
    expect(made2).toHaveLength(2);
    expect(made2[1]?.dedupKey).toBe(`offer_made:${tripId}:d1:COUNTER:900`);
    expect(made2[1]?.dedupKey).not.toBe(made2[0]?.dedupKey);
  });

  it('sweepExpired limpia (ZREM) el id COLGADO cuyo board ya no existe → no se re-escanea (GAP #8)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 1, 700);
    const expiresAt = (await c.store.getBoard(tripId))?.expiresAt ?? 0;
    // El board expiró por TTL de Redis pero su id quedó colgado en el expiry-zset (con su score viejo).
    c.store.__danglingDrop(tripId, expiresAt);
    // El id colgado SIGUE apareciendo en el rango DUE (su score está en el pasado).
    expect(await c.store.dueBoardIds(Date.now() + 5_000)).toContain(tripId);

    const closed = await c.svc.sweepExpired(Date.now() + 5_000);
    expect(closed).toBe(1);
    // Emite window_expired una vez y, sobre todo, REMUEVE el id del expiry-zset.
    expect(c.outbox.byType('dispatch.no_offers')).toHaveLength(1);
    expect(await c.store.dueBoardIds(Date.now() + 10_000)).not.toContain(tripId);

    // Segunda corrida del barrido: el id ya no está → no re-procesa (no infinite re-scan).
    const closedAgain = await c.svc.sweepExpired(Date.now() + 10_000);
    expect(closedAgain).toBe(0);
    expect(c.outbox.byType('dispatch.no_offers')).toHaveLength(1);
  });

  it('reopenBoard (trip.reassigning) re-abre el board al bid (posiblemente subido)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 1, 700);
    await c.svc.sweepExpired(Date.now() + 5_000); // expira
    expect((await c.store.getBoard(tripId))?.status).toBe('EXPIRED');

    await c.svc.reopenBoard({
      tripId,
      driverId: 'drv-cancel',
      passengerId: PASSENGER,
      vehicleType: VehicleType.CAR,
      origin: ORIGIN,
      destination: DEST,
      distanceMeters: DIST_METERS,
      durationSeconds: DUR_SECONDS,
      bidCents: 900,
      negotiationSeq: 1,
    });
    const board = await c.store.getBoard(tripId);
    expect(board?.status).toBe('OPEN');
    expect(board?.bidCents).toBe(900);
  });

  it('reopenBoard PURGA las ofertas de la ventana previa (N4: no sobrevive un COUNTER rancio)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 1, 700);
    // Una oferta de la ventana ORIGINAL (COUNTER a 900 sobre el bid de 700).
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'COUNTER', priceCents: 900 });
    expect((await c.store.listOffers(tripId)).map((o) => o.driverId)).toEqual(['d1']);
    await c.svc.sweepExpired(Date.now() + 5_000); // expira la ventana

    // Reabrir a un bid SUBIDO: la oferta vieja NO debe sobrevivir al HASH.
    await c.svc.reopenBoard({
      tripId,
      driverId: 'drv-cancel',
      passengerId: PASSENGER,
      vehicleType: VehicleType.CAR,
      origin: ORIGIN,
      destination: DEST,
      distanceMeters: DIST_METERS,
      durationSeconds: DUR_SECONDS,
      bidCents: 1100,
      negotiationSeq: 1,
    });

    // El HASH de ofertas arranca LIMPIO: la oferta de la ventana previa ya no está.
    expect(await c.store.listOffers(tripId)).toHaveLength(0);
    // Y no se puede aceptar (ya no existe) → NotFound, jamás un precio rancio.
    let caught: unknown;
    try {
      await c.svc.acceptOffer(tripId, 'd1', PASSENGER);
    } catch (e) {
      caught = e;
    }
    expect(isDomainError(caught) && caught.httpStatus === 404).toBe(true);
  });

  it('acceptOffer rechaza una oferta NO PENDING (STALE/LAPSED) con 409 (N4 defensa en profundidad)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });
    // La oferta quedó rancia (p.ej. el conductor dejó de ser elegible en otra ronda) → STALE.
    await c.store.setOfferStatus(tripId, 'd1', 'STALE');

    let caught: unknown;
    try {
      await c.svc.acceptOffer(tripId, 'd1', PASSENGER);
    } catch (e) {
      caught = e;
    }
    expect(isDomainError(caught) && caught.httpStatus === 409).toBe(true);
    expect((caught as { details?: { reason?: string } }).details?.reason).toBe('offer_not_pending');
    // El board NO se reclamó (sigue OPEN), sin match.
    expect((await c.store.getBoard(tripId))?.status).toBe('OPEN');
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(0);
  });

  it('acceptOffer de una oferta PENDING sigue funcionando tras el guard (un solo match)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });
    const accepted = await c.svc.acceptOffer(tripId, 'd1', PASSENGER);
    expect(accepted.status).toBe('ACCEPTED');
    expect((await c.store.getBoard(tripId))?.status).toBe('CLOSED_MATCHED');
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(1);
  });

  it('listOffers (vista pasajero) devuelve SOLO PENDING: oculta STALE/LAPSED/WITHDRAWN (N6)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });
    await c.svc.submitOffer({ driverId: 'd2', tripId, kind: 'COUNTER', priceCents: 900 });
    await c.svc.submitOffer({ driverId: 'd3', tripId, kind: 'COUNTER', priceCents: 950 });
    // d2 quedó STALE, d3 LAPSED — muertas, no deben aparecer en la vista del pasajero.
    await c.store.setOfferStatus(tripId, 'd2', 'STALE');
    await c.store.setOfferStatus(tripId, 'd3', 'LAPSED');

    const visible = await c.svc.listOffers(tripId);
    expect(visible.map((o) => o.driverId)).toEqual(['d1']);
    expect(visible.every((o) => o.status === 'PENDING')).toBe(true);
    // El store interno SÍ sigue viendo todas (lo usan accept/sweep para transicionar estados).
    expect(await c.store.listOffers(tripId)).toHaveLength(3);
  });

  it('FIX contrato · getOffersView OPEN: status OPEN + expiresAt + SOLO ofertas PENDING', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });
    await c.svc.submitOffer({ driverId: 'd2', tripId, kind: 'COUNTER', priceCents: 900 });
    await c.store.setOfferStatus(tripId, 'd2', 'LAPSED'); // muerta → no debe verse

    const view = await c.svc.getOffersView(tripId, PASSENGER);
    expect(view.board.status).toBe('OPEN');
    expect(typeof view.board.expiresAt).toBe('number');
    expect(view.offers.map((o) => o.driverId)).toEqual(['d1']);
  });

  it('FIX contrato · getOffersView CANCELLED: status CANCELLED + offers vacío (no zombies)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });
    await c.svc.cancelBoard(tripId, PASSENGER, { emitClosure: true });

    const view = await c.svc.getOffersView(tripId, PASSENGER);
    expect(view.board.status).toBe('CANCELLED');
    expect(view.offers).toEqual([]);
  });

  it('FIX contrato · getOffersView GONE: board ausente (TTL) → status GONE, expiresAt null, offers vacío', async () => {
    const c = await ctx();
    const view = await c.svc.getOffersView('trip-no-board', PASSENGER);
    expect(view.board.status).toBe('GONE');
    expect(view.board.expiresAt).toBeNull();
    expect(view.offers).toEqual([]);
  });

  // ── CAPA 2 · ownership del board (defensa en profundidad anti-IDOR/confused-deputy) ─────────────
  //
  // El board pertenece al pasajero que abrió la puja (openBoard siembra passengerId=PASSENGER). Un
  // pasajero AJENO (OTHER) — aud public-rail válido pero otro userId que se coló pasando la CAPA 1 —
  // NO puede aceptar, ver ni cancelar la puja de otro. El board GONE/inexistente es la ÚNICA excepción:
  // sin ancla de ownership no se valida (no leakea: GONE en view, cierre del viaje igual en cancel).
  const OTHER = 'attacker-9';

  it('CAPA 2 · acceptOffer con passengerId AJENO → 403, NO materializa match, board sigue OPEN', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });

    let caught: unknown;
    try {
      await c.svc.acceptOffer(tripId, 'd1', OTHER);
    } catch (e) {
      caught = e;
    }
    expect(isDomainError(caught) && caught.httpStatus === 403).toBe(true);
    // NO se materializó match alguno y el board sigue OPEN (el dueño legítimo aún puede aceptar).
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(0);
    expect(c.outbox.byType('dispatch.offer_accepted')).toHaveLength(0);
    expect((await c.store.getBoard(tripId))?.status).toBe('OPEN');
  });

  it('CAPA 2 · acceptOffer con el passengerId DUEÑO → flujo normal (matchea)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });
    await c.svc.acceptOffer(tripId, 'd1', PASSENGER);
    expect((await c.store.getBoard(tripId))?.status).toBe('CLOSED_MATCHED');
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(1);
  });

  it('CAPA 2 · getOffersView con passengerId AJENO → 403', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    let caught: unknown;
    try {
      await c.svc.getOffersView(tripId, OTHER);
    } catch (e) {
      caught = e;
    }
    expect(isDomainError(caught) && caught.httpStatus === 403).toBe(true);
  });

  it('CAPA 2 · getOffersView board GONE con CUALQUIER passengerId → GONE (no 403, no filtra)', async () => {
    const c = await ctx();
    // El guard de ownership va DESPUÉS del check GONE: con board ausente NO se valida ownership.
    const view = await c.svc.getOffersView('trip-no-board', OTHER);
    expect(view.board.status).toBe('GONE');
    expect(view.offers).toEqual([]);
  });

  it('CAPA 2 · cancelBoard con passengerId AJENO sobre board existente → 403, board NO se cancela', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    let caught: unknown;
    try {
      await c.svc.cancelBoard(tripId, OTHER, { emitClosure: true });
    } catch (e) {
      caught = e;
    }
    expect(isDomainError(caught) && caught.httpStatus === 403).toBe(true);
    // El board sigue OPEN y NO se emitió cierre del viaje (el ajeno no puede cerrar nada).
    expect((await c.store.getBoard(tripId))?.status).toBe('OPEN');
    expect(c.outbox.byType('dispatch.bid_cancelled')).toHaveLength(0);
  });

  it('CAPA 2 · cancelBoard con el passengerId DUEÑO → cancela', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.cancelBoard(tripId, PASSENGER, { emitClosure: true });
    expect((await c.store.getBoard(tripId))?.status).toBe('CANCELLED');
    expect(c.outbox.byType('dispatch.bid_cancelled')).toHaveLength(1);
  });

  it('CAPA 2 · cancelBoard board evaporado por TTL (sin ancla) + emitClosure → emite cierre igual', async () => {
    const c = await ctx();
    // Nunca se abrió board (board null): sin ancla de ownership NO se valida — el viaje puede seguir
    // REQUESTED y debe cerrarse. Cubierto por CAPA 1 (public-rail) + autoridad durable de trip-service.
    await c.svc.cancelBoard('trip-gone', OTHER, { emitClosure: true });
    expect(c.outbox.byType('dispatch.bid_cancelled')).toHaveLength(1);
  });

  it('reopenBoard RECONSTRUYE el board aunque NO haya board previo en Redis (caso huérfano, robustez #4)', async () => {
    const c = await ctx();
    const cell = toH3(ORIGIN, DISPATCH_H3_RESOLUTION);
    await c.hotIndex.seed('d-near', ORIGIN.lat, ORIGIN.lon, cell, VehicleType.CAR);

    // SIN openBoard previo: la key del board ya expiró por TTL minutos antes (el caso real de #4).
    expect(await c.store.getBoard('trip-orphan')).toBeNull();

    await c.svc.reopenBoard({
      tripId: 'trip-orphan',
      driverId: 'drv-cancel',
      passengerId: PASSENGER,
      vehicleType: VehicleType.CAR,
      origin: ORIGIN,
      destination: DEST,
      distanceMeters: DIST_METERS,
      durationSeconds: DUR_SECONDS,
      bidCents: 950,
      negotiationSeq: 1,
    });

    const board = await c.store.getBoard('trip-orphan');
    expect(board?.status).toBe('OPEN');
    expect(board?.bidCents).toBe(950);
    expect(board?.passengerId).toBe(PASSENGER);
    expect(board?.vehicleType).toBe(VehicleType.CAR);
    // Y difunde la re-puja a los conductores elegibles cercanos reconstruidos desde el payload.
    expect(c.delivery.delivered.map((d) => d.driverId)).toContain('d-near');
  });

  it('listOpenBidsNear devuelve solo pujas OPEN cercanas del mismo vehículo del conductor', async () => {
    const c = await ctx();
    const cell = toH3(ORIGIN, DISPATCH_H3_RESOLUTION);
    await c.hotIndex.seed('d1', ORIGIN.lat, ORIGIN.lon, cell, VehicleType.CAR);
    // Board cercano CAR (debe aparecer).
    await openBoard(c, 60, 700);
    // Board lejano (otra región) NO debe aparecer.
    await c.svc.openBoard({
      tripId: 'trip-far',
      passengerId: PASSENGER,
      bidCents: 800,
      vehicleType: VehicleType.CAR,
      origin: { lat: 40.4168, lon: -3.7038 }, // Madrid, fuera del k-ring de Lima
      destination: DEST,
      distanceMeters: DIST_METERS,
      durationSeconds: DUR_SECONDS,
      windowSec: 60,
      negotiationSeq: 1,
    });
    // Board MOTO cercano NO debe aparecer (vehículo no coincide).
    await c.svc.openBoard({
      tripId: 'trip-moto',
      passengerId: PASSENGER,
      bidCents: 600,
      vehicleType: VehicleType.MOTO,
      origin: ORIGIN,
      destination: DEST,
      distanceMeters: DIST_METERS,
      durationSeconds: DUR_SECONDS,
      windowSec: 60,
      negotiationSeq: 1,
    });

    const bids = await c.svc.listOpenBidsNear('d1');
    expect(bids.map((n) => n.board.tripId)).toEqual(['trip-1']);
    // Cada puja sale enriquecida con el ETA conductor→recojo del FakeMaps (dato de decisión de la card).
    expect(bids.map((n) => n.pickupEtaSeconds)).toEqual([120]);
  });

  it('listOpenBidsNear con maps.eta caído → pickupEtaSeconds 0 (degrada, NUNCA rompe el poll)', async () => {
    const c = await ctx();
    const cell = toH3(ORIGIN, DISPATCH_H3_RESOLUTION);
    await c.hotIndex.seed('d1', ORIGIN.lat, ORIGIN.lon, cell, VehicleType.CAR);
    await openBoard(c, 60, 700);
    // El fallo del proveedor de rutas es por-board y silencioso: la puja sale igual, con eta 0
    // (el controller la OMITE del DTO para que la app degrade el stat "A recojo").
    c.maps.eta = async () => {
      throw new Error('osrm down');
    };
    const bids = await c.svc.listOpenBidsNear('d1');
    expect(bids.map((n) => n.board.tripId)).toEqual(['trip-1']);
    expect(bids.map((n) => n.pickupEtaSeconds)).toEqual([0]);
  });

  it('B5-3: listOpenBidsNear FILTRA por TIER — un conductor que no cumple los requires del board NO lo ve', async () => {
    const c = await ctx();
    const cell = toH3(ORIGIN, DISPATCH_H3_RESOLUTION);
    // Conductor CAR económico de 4 asientos (attrs presentes) → no cumple VEO_XL (minSeats:6).
    await c.hotIndex.seed('d-small', ORIGIN.lat, ORIGIN.lon, cell, VehicleType.CAR, {
      seats: 4,
      segment: VehicleSegment.ECONOMY,
      vehicleYear: 2022,
    });
    // Board XL cercano (mismo vehicleType CAR pero tier superior).
    await c.svc.openBoard({
      tripId: 'trip-xl',
      passengerId: PASSENGER,
      bidCents: 700,
      vehicleType: VehicleType.CAR,
      category: OfferingId.VEO_XL,
      origin: ORIGIN,
      destination: DEST,
      distanceMeters: DIST_METERS,
      durationSeconds: DUR_SECONDS,
      windowSec: 60,
      negotiationSeq: 1,
    });
    // Board sin category (RIDE genérico): debe verlo igual.
    await c.svc.openBoard({
      tripId: 'trip-any',
      passengerId: PASSENGER,
      bidCents: 700,
      vehicleType: VehicleType.CAR,
      origin: ORIGIN,
      destination: DEST,
      distanceMeters: DIST_METERS,
      durationSeconds: DUR_SECONDS,
      windowSec: 60,
      negotiationSeq: 1,
    });

    // El conductor chico NO ve el board XL, pero SÍ el genérico.
    expect((await c.svc.listOpenBidsNear('d-small')).map((n) => n.board.tripId)).toEqual([
      'trip-any',
    ]);

    // Un conductor con van de 7 asientos SÍ ve el board XL.
    await c.hotIndex.seed('d-van', ORIGIN.lat, ORIGIN.lon, cell, VehicleType.CAR, {
      seats: 7,
      segment: VehicleSegment.ECONOMY,
      vehicleYear: 2022,
    });
    expect((await c.svc.listOpenBidsNear('d-van')).map((n) => n.board.tripId).sort()).toEqual([
      'trip-any',
      'trip-xl',
    ]);
  });

  it('B5-3: listOpenBidsNear fail-OPEN — un conductor LEGACY sin attrs SÍ ve un board de tier (no se excluye)', async () => {
    const c = await ctx();
    const cell = toH3(ORIGIN, DISPATCH_H3_RESOLUTION);
    // Conductor sin attrs (ping legacy) → fail-open: NO se lo excluye del board XL.
    await c.hotIndex.seed('d-legacy', ORIGIN.lat, ORIGIN.lon, cell, VehicleType.CAR);
    await c.svc.openBoard({
      tripId: 'trip-xl',
      passengerId: PASSENGER,
      bidCents: 700,
      vehicleType: VehicleType.CAR,
      category: OfferingId.VEO_XL,
      origin: ORIGIN,
      destination: DEST,
      distanceMeters: DIST_METERS,
      durationSeconds: DUR_SECONDS,
      windowSec: 60,
      negotiationSeq: 1,
    });
    expect((await c.svc.listOpenBidsNear('d-legacy')).map((n) => n.board.tripId)).toEqual([
      'trip-xl',
    ]);
  });

  // ── A3: índice inverso celda→board (listOpenBidsNear por k-ring, no all-scan) ──────────────────
  it('A3: listOpenBidsNear consulta SOLO las celdas del k-ring (boardsInCells), NO escanea todos los OPEN', async () => {
    const c = await ctx();
    const cell = toH3(ORIGIN, DISPATCH_H3_RESOLUTION);
    await c.hotIndex.seed('d1', ORIGIN.lat, ORIGIN.lon, cell, VehicleType.CAR);
    await openBoard(c, 60, 700);

    c.store.boardsInCellsCalls = 0;
    c.store.boardsInCellsArgs.length = 0;
    c.store.listOpenBoardsCalls = 0;
    await c.svc.listOpenBidsNear('d1');

    // Pasó por el índice de celda (UNA consulta) y NO por el all-scan listOpenBoards.
    expect(c.store.boardsInCellsCalls).toBe(1);
    expect(c.store.listOpenBoardsCalls).toBe(0);
    // Las celdas pedidas son EXACTAMENTE el k-ring del conductor (neighbors del centro, radio configurado).
    const kRing = neighbors(cell, 2); // DISPATCH_MAX_K_RING=2 en makeService
    expect(c.store.boardsInCellsArgs[0]?.slice().sort()).toEqual(kRing.slice().sort());
    // Y el k-ring contiene la celda de origen del board cercano.
    expect(c.store.boardsInCellsArgs[0]).toContain(cell);
  });

  it('A3: un board FUERA del k-ring del conductor NO se devuelve (no está en ninguna celda consultada)', async () => {
    const c = await ctx();
    const cell = toH3(ORIGIN, DISPATCH_H3_RESOLUTION);
    await c.hotIndex.seed('d1', ORIGIN.lat, ORIGIN.lon, cell, VehicleType.CAR);
    // Board lejano (Madrid): su originCell NO cae en el k-ring de Lima → SUNION no lo incluye.
    await c.svc.openBoard({
      tripId: 'trip-far',
      passengerId: PASSENGER,
      bidCents: 800,
      vehicleType: VehicleType.CAR,
      origin: { lat: 40.4168, lon: -3.7038 },
      destination: DEST,
      distanceMeters: DIST_METERS,
      durationSeconds: DUR_SECONDS,
      windowSec: 60,
      negotiationSeq: 1,
    });
    // Board cercano + mismo vehículo: SÍ aparece.
    await openBoard(c, 60, 700);

    const bids = await c.svc.listOpenBidsNear('d1');
    expect(bids.map((n) => n.board.tripId)).toEqual(['trip-1']);
  });

  it('A3: el índice de celda se MANTIENE — open SADD, close (claim/expire/cancel) SREM', async () => {
    const c = await ctx();
    const cell = toH3(ORIGIN, DISPATCH_H3_RESOLUTION);
    await c.hotIndex.seed('d1', ORIGIN.lat, ORIGIN.lon, cell, VehicleType.CAR);
    const kRing = neighbors(cell, 2);

    // 1) ACEPTACIÓN (claim OPEN→CLOSED_MATCHED) saca el board del índice de celda.
    const claimTrip = 'trip-claim';
    await c.svc.openBoard({
      tripId: claimTrip,
      passengerId: PASSENGER,
      bidCents: 700,
      vehicleType: VehicleType.CAR,
      origin: ORIGIN,
      destination: DEST,
      distanceMeters: DIST_METERS,
      durationSeconds: DUR_SECONDS,
      windowSec: 60,
      negotiationSeq: 1,
    });
    expect((await c.store.boardsInCells(kRing)).map((b) => b.tripId)).toContain(claimTrip);
    await c.svc.submitOffer({
      driverId: 'd1',
      tripId: claimTrip,
      kind: 'ACCEPT_PRICE',
      priceCents: 700,
    });
    await c.svc.acceptOffer(claimTrip, 'd1', PASSENGER);
    expect((await c.store.boardsInCells(kRing)).map((b) => b.tripId)).not.toContain(claimTrip);

    // 2) EXPIRACIÓN (sweep OPEN→EXPIRED) saca el board del índice de celda. Ventana 1s vía runtime.
    const expTrip = 'trip-exp';
    c.windows.bidWindowSec = 1;
    await c.svc.openBoard({
      tripId: expTrip,
      passengerId: PASSENGER,
      bidCents: 700,
      vehicleType: VehicleType.CAR,
      origin: ORIGIN,
      destination: DEST,
      distanceMeters: DIST_METERS,
      durationSeconds: DUR_SECONDS,
      windowSec: 1,
      negotiationSeq: 1,
    });
    expect((await c.store.boardsInCells(kRing)).map((b) => b.tripId)).toContain(expTrip);
    await c.svc.sweepExpired(Date.now() + 5_000);
    expect((await c.store.boardsInCells(kRing)).map((b) => b.tripId)).not.toContain(expTrip);

    // 3) CANCELACIÓN (setBoardStatus OPEN→CANCELLED) saca el board del índice de celda. Ventana 60s.
    const cancelTrip = 'trip-cancel';
    c.windows.bidWindowSec = 60;
    await c.svc.openBoard({
      tripId: cancelTrip,
      passengerId: PASSENGER,
      bidCents: 700,
      vehicleType: VehicleType.CAR,
      origin: ORIGIN,
      destination: DEST,
      distanceMeters: DIST_METERS,
      durationSeconds: DUR_SECONDS,
      windowSec: 60,
      negotiationSeq: 1,
    });
    expect((await c.store.boardsInCells(kRing)).map((b) => b.tripId)).toContain(cancelTrip);
    await c.svc.cancelBoard(cancelTrip, PASSENGER);
    expect((await c.store.boardsInCells(kRing)).map((b) => b.tripId)).not.toContain(cancelTrip);
  });

  it('listOpenBidsNear con gate NO elegible → 403', async () => {
    const c = await ctx(false);
    const cell = toH3(ORIGIN, DISPATCH_H3_RESOLUTION);
    await c.hotIndex.seed('d1', ORIGIN.lat, ORIGIN.lon, cell, VehicleType.CAR);
    await openBoard(c, 60, 700);
    let caught: unknown;
    try {
      await c.svc.listOpenBidsNear('d1');
    } catch (e) {
      caught = e;
    }
    expect(isDomainError(caught) && caught.httpStatus === 403).toBe(true);
  });

  it('listOpenBidsNear sin ubicación viva del conductor → [] (no lanza)', async () => {
    const c = await ctx();
    await openBoard(c, 60, 700);
    expect(await c.svc.listOpenBidsNear('sin-loc')).toEqual([]);
  });

  it('submitOffer sobre board no OPEN → ConflictError', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.cancelBoard(tripId, PASSENGER);
    let caught: unknown;
    try {
      await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });
    } catch (e) {
      caught = e;
    }
    expect(isDomainError(caught) && caught.httpStatus === 409).toBe(true);
  });
});

// ── Concurrencia (H1: cierre de las carreras del board) ───────────────────────────────────────────
//
// La prueba del CAS atómico: con DOS aceptaciones / aceptación-vs-expire disparadas "a la vez"
// (Promise.allSettled), EXACTAMENTE UNA gana y emite el match; la otra NO emite NADA. El fake en
// memoria es atómico-equivalente (sección crítica sin await), igual que el Lua de Redis serializa.
describe('OfferBoardService — concurrencia del board (H1, CAS atómico)', () => {
  it('dos acceptOffer concurrentes de conductores DISTINTOS → exactamente UN match, el otro 409 sin emitir', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });
    await c.svc.submitOffer({ driverId: 'd2', tripId, kind: 'COUNTER', priceCents: 900 });

    const results = await Promise.allSettled([
      c.svc.acceptOffer(tripId, 'd1', PASSENGER),
      c.svc.acceptOffer(tripId, 'd2', PASSENGER),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    // Ganador único: una resuelve, la otra rechaza con ConflictError (409).
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const err = rejected[0]?.reason;
    expect(isDomainError(err) && err.httpStatus === 409).toBe(true);

    // EXACTAMENTE UN par offer_accepted + match_found (el perdedor no emitió nada).
    expect(c.outbox.byType('dispatch.offer_accepted')).toHaveLength(1);
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(1);
    // El board quedó CLOSED_MATCHED (no doble transición).
    expect((await c.store.getBoard(tripId))?.status).toBe('CLOSED_MATCHED');
    // El conductor ganador es el del match emitido (consistencia accepted/match).
    const matchDriver = (
      c.outbox.byType('dispatch.match_found')[0]?.payload as { driverId: string }
    ).driverId;
    expect(['d1', 'd2']).toContain(matchDriver);
    expect(
      (c.outbox.byType('dispatch.offer_accepted')[0]?.payload as { driverId: string }).driverId,
    ).toBe(matchDriver);
  });

  it('acceptOffer vs expireIfOpen concurrentes → board CLOSED_MATCHED XOR EXPIRED, nunca ambos', async () => {
    // Ventana ya vencida (expiresAt en el pasado) → el sweep es elegible para expirar.
    const c = await ctx();
    const tripId = await openBoard(c, 1, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });

    const now = Date.now() + 5_000; // ventana de 1s ya pasó
    const results = await Promise.allSettled([
      c.svc.acceptOffer(tripId, 'd1', PASSENGER),
      c.svc.sweepExpired(now),
    ]);

    const board = await c.store.getBoard(tripId);
    const matchFound = c.outbox.byType('dispatch.match_found').length;
    const noOffers = c.outbox.byType('dispatch.no_offers').length;

    // Exactamente uno de los dos resultados terminales, nunca ambos.
    expect(board?.status === 'CLOSED_MATCHED' || board?.status === 'EXPIRED').toBe(true);
    // Y los emits son mutuamente excluyentes: o un match_found, o un no_offers — nunca los dos.
    expect(matchFound + noOffers).toBe(1);
    if (board?.status === 'CLOSED_MATCHED') {
      expect(matchFound).toBe(1);
      expect(noOffers).toBe(0);
      // El acceptOffer ganó → su promesa resolvió.
      expect(results[0].status).toBe('fulfilled');
    } else {
      expect(noOffers).toBe(1);
      expect(matchFound).toBe(0);
      // El expire ganó → acceptOffer rechazó con 409.
      expect(results[0].status).toBe('rejected');
    }
  });

  it('submitOffer sobre un board recién cerrado (acepta-luego-oferta) → rechazado, no se almacena', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });
    await c.svc.acceptOffer(tripId, 'd1', PASSENGER); // board → CLOSED_MATCHED

    let caught: unknown;
    try {
      await c.svc.submitOffer({ driverId: 'd2', tripId, kind: 'COUNTER', priceCents: 900 });
    } catch (e) {
      caught = e;
    }
    expect(isDomainError(caught) && caught.httpStatus === 409).toBe(true);
    // d2 nunca se almacenó.
    expect((await c.store.listOffers(tripId)).map((o) => o.driverId)).toEqual(['d1']);
  });
});

// ── N5: trip huérfano entre el claim atómico y la commit del outbox ────────────────────────────────
//
// Si la tx de outbox FALLA tras ganar el claim (board CLOSED_MATCHED), el board quedaría cerrado SIN
// match_found jamás emitido → trip huérfano en REQUESTED que el watchdog EXPIRARÍA por error. El fix:
// acción compensatoria (revertir el board a OPEN para reintentar) + reconciliador para el residual crash.
describe('OfferBoardService — N5: revert compensatorio + reconciliador del match huérfano', () => {
  it('si la tx de outbox FALLA, el board se REVIERTE a OPEN (reintentable), sin match y sin medio-cerrar', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });

    c.outbox.failNextTx = true; // la próxima tx de outbox lanza (simula fallo Postgres)
    await expect(c.svc.acceptOffer(tripId, 'd1', PASSENGER)).rejects.toThrow();

    // Compensación: el board volvió a OPEN — el pasajero puede reintentar (la oferta sigue ahí).
    expect((await c.store.getBoard(tripId))?.status).toBe('OPEN');
    // NINGÚN evento se encoló (la tx abortó y se hizo rollback).
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(0);
    expect(c.outbox.byType('dispatch.offer_accepted')).toHaveLength(0);
    // La oferta NO quedó flipeada a ACCEPTED (orden durable-primero: aún PENDING para reintentar).
    expect((await c.store.getOffer(tripId, 'd1'))?.status).toBe('PENDING');
  });

  it('tras el revert por fallo, un reintento del accept SÍ matchea (un solo match)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });

    c.outbox.failNextTx = true;
    await expect(c.svc.acceptOffer(tripId, 'd1', PASSENGER)).rejects.toThrow();

    // Reintento limpio (la tx ya no falla): matchea normalmente.
    await c.svc.acceptOffer(tripId, 'd1', PASSENGER);
    expect((await c.store.getBoard(tripId))?.status).toBe('CLOSED_MATCHED');
    expect((await c.store.getOffer(tripId, 'd1'))?.status).toBe('ACCEPTED');
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(1);
  });

  it('el happy accept marca matchEmitted → el reconciliador NO re-emite (no doble match)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });
    await c.svc.acceptOffer(tripId, 'd1', PASSENGER);
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(1);

    // El board ya tiene matchEmitted=true → no está pendiente de reconciliación.
    const reemitted = await c.svc.reconcileUnemittedMatches();
    expect(reemitted).toBe(0);
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(1); // sigue en UNO
  });

  it('reconciliador: un board CLOSED_MATCHED sin emitir (residual hard-crash) re-emite match_found UNA vez', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });
    // Simula el crash: claim aplicado (CLOSED_MATCHED, acceptedDriverId) pero el proceso murió ANTES de
    // commitear/emitir el match → board en el matched-set, matchEmitted=false, sin match_found.
    c.store.__crashedMatch(tripId, 'd1');
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(0);

    const reemitted = await c.svc.reconcileUnemittedMatches();
    expect(reemitted).toBe(1);
    // Re-emitió el par offer_accepted + match_found con el precio acordado del conductor.
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(1);
    expect(c.outbox.byType('dispatch.offer_accepted')).toHaveLength(1);
    expect(
      (c.outbox.byType('dispatch.offer_accepted')[0]?.payload as { priceCents: number }).priceCents,
    ).toBe(700);
    // H13 — el re-emit del reconciliador estampa el MISMO seq del ciclo del board (1, de openBoard).
    expect(
      (c.outbox.byType('dispatch.offer_accepted')[0]?.payload as { negotiationSeq: number })
        .negotiationSeq,
    ).toBe(1);

    // Segunda corrida del reconciliador: ya marcado → no re-emite (idempotente).
    const again = await c.svc.reconcileUnemittedMatches();
    expect(again).toBe(0);
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(1);
  });

  it('H8: el reconciliador NO toca un match RECIÉN hecho (dentro del grace) — solo los atascados viejos', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });

    const now = 1_000_000_000_000;
    // Match RECIÉN reclamado (claimedAt = now): aún dentro del grace de 5s → el reconciliador lo SALTEA.
    c.store.__crashedMatch(tripId, 'd1', now);
    const fresh = await c.svc.reconcileUnemittedMatches(now);
    expect(fresh).toBe(0);
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(0); // NO re-emitido (el happy-path lo drena)

    // El MISMO board, pero ahora ya pasó el grace (claim es > 5s viejo) → SÍ se reconcilia.
    const reemitted = await c.svc.reconcileUnemittedMatches(now + 6_000);
    expect(reemitted).toBe(1);
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(1);
  });

  it('H8: matchedUnemittedBoards filtra por score (claimedAtMs) — recientes fuera, viejos dentro', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    const now = 1_000_000_000_000;
    c.store.__crashedMatch(tripId, 'd1', now);
    // cutoff = now - grace: el match con score=now NO entra (es reciente).
    expect(await c.store.matchedUnemittedBoards(now - 5_000)).toHaveLength(0);
    // cutoff = now + 6s: el match con score=now SÍ entra (ya es viejo).
    expect((await c.store.matchedUnemittedBoards(now + 1_000)).map((b) => b.tripId)).toEqual([
      tripId,
    ]);
  });

  it('reconciliador: usa dedupKey ESTABLE → un re-emit dedupea con el match original (idempotencia downstream)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });
    c.store.__crashedMatch(tripId, 'd1');
    await c.svc.reconcileUnemittedMatches();
    const match = c.outbox.byType('dispatch.match_found');
    expect(match[0]?.dedupKey).toBe(`match_found:${tripId}:d1`);
  });

  // ── Finding #4a — la dedupKey estable evita apilar eventos en reconcile/retry ──────────────────
  it('#4a: re-correr el reconciliador (misma dedupKey) NO apila un segundo match_found (P2002 swallow)', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    await c.svc.submitOffer({ driverId: 'd1', tripId, kind: 'ACCEPT_PRICE', priceCents: 700 });
    // Crash: board CLOSED_MATCHED sin emitir + fila ACCEPTED persistida (price 700).
    c.store.__crashedMatch(tripId, 'd1');

    // Primera reconciliación: emite el par una vez.
    const first = await c.svc.reconcileUnemittedMatches();
    expect(first).toBe(1);
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(1);
    expect(c.outbox.byType('dispatch.match_found')[0]?.dedupKey).toBe(`match_found:${tripId}:d1`);

    // Simulamos que el board volvió a quedar "no emitido" (p.ej. la marca matchEmitted se perdió tras un
    // segundo crash) → el reconciliador re-corre con la MISMA dedupKey ya insertada. El re-insert lanza
    // P2002 y el service lo TRAGA como ya-hecho: NO se apila un segundo match_found.
    c.store.__crashedMatch(tripId, 'd1');
    const second = await c.svc.reconcileUnemittedMatches();
    expect(second).toBe(1); // contó el board como reconciliado (idempotente), no falló
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(1); // SIGUE en UNO (no apiló)
    expect(c.outbox.byType('dispatch.offer_accepted')).toHaveLength(1);
  });

  // ── Finding #11 — el reconciliador NUNCA fabrica un precio ─────────────────────────────────────
  it('#11: reconcile SIN precio persistido (y oferta efímera ausente) NO emite un precio fabricado', async () => {
    const c = await ctx();
    const tripId = await openBoard(c, 60, 700);
    // Crash SIN fila ACCEPTED persistida (agreedPriceCents recuperable=null) Y sin oferta en Redis
    // (getOffer = null): el bug previo caía a board.bidCents (700) — ahora debe SALTAR sin fabricar precio.
    c.store.__crashedMatch(tripId, 'd1', 0, null);
    // No hay oferta efímera (nunca se hizo submitOffer): getOffer → null.
    expect(await c.store.getOffer(tripId, 'd1')).toBeNull();

    const reemitted = await c.svc.reconcileUnemittedMatches();

    // CERO eventos: no fabricó offer_accepted ni match_found con el bid del board.
    expect(reemitted).toBe(0);
    expect(c.outbox.byType('dispatch.offer_accepted')).toHaveLength(0);
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(0);
    // NO marcó matchEmitted → un run posterior (cuando los datos sean consistentes) puede reintentar.
    expect((await c.store.getBoard(tripId))?.matchEmitted).not.toBe(true);
  });

  it('#11: reconcile USA el precio DURABLE de DispatchMatch (no el bid del board efímero)', async () => {
    const c = await ctx();
    // board.bidCents = 700, PERO el precio acordado persistido fue 900 (un COUNTER aceptado).
    const tripId = await openBoard(c, 60, 700);
    // Crash con fila ACCEPTED persistida a 900 (lo que acordó el conductor) y SIN oferta efímera en Redis.
    c.store.__crashedMatch(tripId, 'd1', 0, 900);
    expect(await c.store.getOffer(tripId, 'd1')).toBeNull(); // la oferta efímera se evaporó

    const reemitted = await c.svc.reconcileUnemittedMatches();

    expect(reemitted).toBe(1);
    // El precio sale de la BD (900), NO del bid efímero del board (700) → la BD es la fuente de verdad.
    expect(
      (c.outbox.byType('dispatch.offer_accepted')[0]?.payload as { priceCents: number }).priceCents,
    ).toBe(900);
    expect(c.outbox.byType('dispatch.match_found')).toHaveLength(1);
  });
});

describe('OfferBoardService — broadcast radius (dispatch-policy v2)', () => {
  const V2: DispatchPolicyV2 = {
    FIXED: {
      initialRadiusKm: 0.3,
      incrementKm: 0.3,
      maxRadiusKm: 1.5,
      targetDrivers: 3,
      offerTimeoutSec: 20,
      expandIntervalSec: 8,
    },
    PUJA: { broadcastRadiusKm: 1.2, bidWindowSec: 60 }, // 1.2km → k4 (el fake v1 usa matchKRing=2)
  };

  /** Una celda exactamente en el anillo 3 del centro (fuera del k2 de v1, dentro del k4 de v2). */
  function cellAtRing3(): string {
    const center = toH3(ORIGIN, DISPATCH_H3_RESOLUTION);
    const inner = new Set(neighbors(center, 2));
    return neighbors(center, 3).find((cc) => !inner.has(cc))!;
  }

  it('v1: el broadcast usa matchKRing (un conductor en el anillo 3 NO recibe el bid)', async () => {
    const c = await ctx(); // policy v1 por default
    const center = toH3(ORIGIN, DISPATCH_H3_RESOLUTION);
    await c.hotIndex.seed('d-near', ORIGIN.lat, ORIGIN.lon, center, VehicleType.CAR);
    await c.hotIndex.seed('d-far', ORIGIN.lat, ORIGIN.lon, cellAtRing3(), VehicleType.CAR);
    await openBoard(c);
    // matchKRing=2 → solo el del centro; el del anillo 3 queda fuera.
    expect(c.delivery.delivered.map((d) => d.driverId)).toEqual(['d-near']);
  });

  it('v2: el broadcast usa radiusKmToKRing(broadcastRadiusKm) (el conductor del anillo 3 SÍ recibe)', async () => {
    const c = await ctx();
    c.policy.policyVersion = 'v2';
    c.policy.v2 = V2; // broadcastRadiusKm 1.2 → k4 ⊇ anillo 3
    const center = toH3(ORIGIN, DISPATCH_H3_RESOLUTION);
    await c.hotIndex.seed('d-near', ORIGIN.lat, ORIGIN.lon, center, VehicleType.CAR);
    await c.hotIndex.seed('d-far', ORIGIN.lat, ORIGIN.lon, cellAtRing3(), VehicleType.CAR);
    await openBoard(c);
    expect(c.delivery.delivered.map((d) => d.driverId).sort()).toEqual(['d-far', 'd-near']);
  });
});
