/**
 * Implementación del OfferBoardStore sobre Redis real (producción).
 *
 * Claves (todas bajo el TTL de la ventana de puja + margen de barrido):
 *  - `board:{tripId}`        → JSON del OfferBoard.
 *  - `board:offers:{tripId}` → HASH driverId → JSON de la Offer.
 *  - `board:expiry`          → ZSET tripId → score `expiresAt`(ms). Índice de barrido por VENCIMIENTO.
 *  - `board:matched`         → ZSET tripId → score `claimedAtMs`(ms). Índice de reconciliación (N5).
 *  - `board:cell:{h3}`       → ZSET tripId → score `expiresAt`(ms) cuyo ORIGEN cae en esa celda H3 (A3).
 *                              Índice INVERSO celda→board: deja que `listOpenBidsNear` lea SOLO los boards
 *                              del k-ring del conductor (ZRANGEBYSCORE por celda + MGET), no TODOS los OPEN.
 *                              Se mantiene con ZADD<expiresAt> al abrir y ZREM al cerrar
 *                              (claim/expire/cancel/revert), dentro de la misma operación atómica.
 *
 * H11 (índice de celda auto-acotado) — antes era un SET plano: cuando un board moría por TTL de Redis
 * (sin pasar por un Lua de expire/claim), `removeOpenId` solo sacaba del `board:expiry`, jamás del SET de
 * celda, y la key de celda no tiene TTL → tripIds fantasma se acumulaban para siempre en celdas H3
 * calientes (NO era bug de correctitud: el MGET con null-skip los filtraba; sí crecimiento sin cota).
 * Ahora es un ZSET scoreado por `expiresAt` (espejo de `board:expiry`): `boardsInCells` lee solo los
 * miembros AÚN vigentes (`ZRANGEBYSCORE <now> +inf`) y poda los muertos (`ZREMRANGEBYSCORE -inf <now>`)
 * en cada lectura → un board muerto por TTL (score < now) se auto-excluye Y se purga. ZSET acotado.
 *
 * H8 (escalabilidad del barrido) — antes ambos índices eran SET planos y cada tick (2s) hacía DOS
 * SMEMBERS-all O(boards): cientos de k ops/min con miles de boards solo para descubrir que nada vence.
 * Ahora son SORTED-SETS y el barrido lee SOLO el rango DUE:
 *  - sweep:       `ZRANGEBYSCORE board:expiry -inf <now>`           → solo boards vencidos → O(due).
 *  - membresía:   `ZRANGEBYSCORE board:expiry <now> +inf`          → solo boards aún vivos.
 *  - reconciler:  `ZRANGEBYSCORE board:matched -inf <now-grace>`    → solo matched genuinamente atascados.
 * El `EXPIRE_IF_OPEN` Lua DEVUELVE el `expiresAt` (windowEpoch) junto al #ofertas, así el barrido arma
 * la dedupKey `no_offers:${tripId}:${windowEpoch}` SIN un `getBoard` extra por board por tick.
 *
 * Los ZSET NO llevan TTL (son índices de barrido); cada entrada se limpia al cerrar el board
 * (ZREM dentro del Lua de claim/expire/cancel/revert) o, si su board expiró por TTL y quedó colgada,
 * con `removeOpenId` durante el barrido.
 *
 * MIGRACIÓN (cambia la forma de la key Redis: SET→ZSET en `board:open`→`board:expiry`, `board:matched`
 * y, con H11, también `board:cell:<h3>`):
 *  - dev: `FLUSHALL` (o flush de `board:expiry`/`board:matched`/`board:cell:*`) antes del deploy — los
 *    boards efímeros se regeneran solos.
 *  - prod: deploy con ventana de flush de esas keys, o un breve período con ambas formas (las keys viejas
 *    de tipo SET drenan por TTL del board mientras las nuevas pueblan el ZSET). Los boards son efímeros
 *    (TTL ~90s) → la ventana de inconsistencia es acotada. NOTA: un `ZADD`/`ZRANGEBYSCORE` sobre una key
 *    `board:cell:<h3>` que quedó como SET viejo daría WRONGTYPE; por eso `board:cell:*` DEBE flushear-se
 *    (o esperar a que todos los boards previos vencidos por TTL liberen sus keys de celda) en el cutover.
 */
import type Redis from 'ioredis';
import { VehicleType } from '@veo/shared-types';
import type {
  BoardStatus,
  ClaimResult,
  ExpireResult,
  Offer,
  OfferBoard,
  OfferBoardStore,
  OfferStatus,
} from './offer-board.port';

const BOARD_PREFIX = 'board:';
const OFFERS_PREFIX = 'board:offers:';
/** H8 — ZSET de boards OPEN scoreado por `expiresAt`(ms); índice de barrido por vencimiento (range-read). */
const EXPIRY_ZSET = 'board:expiry';
/** N5/H8 — ZSET de boards CLOSED_MATCHED sin match emitido, scoreado por `claimedAtMs`(ms) (reconciliación). */
const MATCHED_ZSET = 'board:matched';
/** A3/H11 — prefijo del índice inverso celda→board: `board:cell:<h3>` es un ZSET tripId→`expiresAt`(ms). */
const CELL_PREFIX = 'board:cell:';

// ── Scripts Lua atómicos (single round-trip; leen el board JSON, chequean el campo y escriben
//    condicionalmente DENTRO del script → serializados por el hilo único de Redis). ──────────────
//
// H11 (de-dup del preámbulo) — dos fragmentos se repetían byte-a-byte en 5-6 scripts; se extraen a
// constantes y se concatenan en cada script (sigue siendo UN solo `eval` por método, comportamiento
// idéntico):
//  - LUA_LOAD_BOARD          → el `GET KEYS[1]` + `cjson.decode` (5 scripts) con su `bail` configurable.
//  - LUA_SAVE_PRESERVE_TTL   → el bloque write-back que conserva el TTL restante (`SET ... EX ttl` o
//                              `SET` pelado si ya no tiene), repetido en 4 scripts.

/**
 * LUA_LOAD_BOARD(bail) — preámbulo compartido: lee el board JSON y lo decodifica en la var local `board`.
 * `bail` es la sentencia Lua a ejecutar si el board NO existe (`raw` es nil), p.ej. `return ''` /
 * `return 0` / `return {-2}` — cada script trae su propio contrato de "board ausente".
 */
const LUA_LOAD_BOARD = (bail: string): string => `
local raw = redis.call('GET', KEYS[1])
if not raw then ${bail} end
local board = cjson.decode(raw)`;

/**
 * LUA_SAVE_PRESERVE_TTL — write-back compartido del board mutado conservando el TTL restante de KEYS[1]
 * (si ya no tiene TTL, persiste sin expiración: el barrido ya lo cerró). Asume `board` en scope.
 */
const LUA_SAVE_PRESERVE_TTL = `
local ttl = redis.call('TTL', KEYS[1])
if ttl and ttl > 0 then
  redis.call('SET', KEYS[1], cjson.encode(board), 'EX', ttl)
else
  redis.call('SET', KEYS[1], cjson.encode(board))
end`;

/**
 * claimBoardForAccept — GATE de ganador único de la aceptación.
 * KEYS[1]=board:{tripId}  KEYS[2]=board:expiry(ZSET)  KEYS[3]=board:matched(ZSET)
 * ARGV[1]=tripId  ARGV[2]=driverId  ARGV[3]=claimedAtMs  ARGV[4]=board:cell: prefijo
 * IF board no existe        → devuelve '' (sin estado).
 * IF status==='OPEN'        → status:=CLOSED_MATCHED, graba acceptedDriverId + matchEmitted=false, conserva
 *                             TTL, ZREM del expiry-zset, ZADD<claimedAtMs> al matched-zset, ZREM del cell-index
 *                             (A3/H11: el board deja de ser OPEN), devuelve 'CLAIMED'.
 * ELSE (ya cerrado)         → no escribe, devuelve el status actual.
 */
const CLAIM_FOR_ACCEPT_SCRIPT = `${LUA_LOAD_BOARD("return ''")}
if board['status'] ~= 'OPEN' then return board['status'] end
board['status'] = 'CLOSED_MATCHED'
board['acceptedDriverId'] = ARGV[2]
board['matchEmitted'] = false
${LUA_SAVE_PRESERVE_TTL}
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1])
if board['originCell'] then redis.call('ZREM', ARGV[4] .. board['originCell'], ARGV[1]) end
return 'CLAIMED'
`;

/**
 * revertClaim — N5 acción compensatoria: des-reclama el board si su match aún NO se emitió.
 * KEYS[1]=board:{tripId}  KEYS[2]=board:expiry(ZSET)  KEYS[3]=board:matched(ZSET)
 * ARGV[1]=tripId  ARGV[2]=board:cell: prefijo
 * IF board CLOSED_MATCHED AND matchEmitted~=true → vuelve a OPEN, borra acceptedDriverId, re-ZADD al
 * expiry-zset con score=expiresAt, ZREM matched-zset, ZADD<expiresAt> de vuelta al cell-index (A3/H11:
 * vuelve a ser OPEN). ELSE no-op (no revierte un match durable).
 */
const REVERT_CLAIM_SCRIPT = `${LUA_LOAD_BOARD('return 0')}
if board['status'] ~= 'CLOSED_MATCHED' then return 0 end
if board['matchEmitted'] == true then return 0 end
board['status'] = 'OPEN'
board['acceptedDriverId'] = nil
board['matchEmitted'] = nil
${LUA_SAVE_PRESERVE_TTL}
redis.call('ZADD', KEYS[2], tonumber(board['expiresAt']), ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
if board['originCell'] then redis.call('ZADD', ARGV[2] .. board['originCell'], tonumber(board['expiresAt']), ARGV[1]) end
return 1
`;

/**
 * markMatchEmitted — N5: marca matchEmitted=true y saca del matched-zset (ya reconciliado / emitido).
 * KEYS[1]=board:{tripId}  KEYS[2]=board:matched(ZSET)  ARGV[1]=tripId. No-op si el board no existe.
 */
const MARK_MATCH_EMITTED_SCRIPT = `${LUA_LOAD_BOARD("redis.call('ZREM', KEYS[2], ARGV[1]); return 0")}
board['matchEmitted'] = true
${LUA_SAVE_PRESERVE_TTL}
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

/**
 * expireIfOpen — expiración condicional atómica (mutuamente excluyente con el claim sobre OPEN).
 * KEYS[1]=board:{tripId}  KEYS[2]=board:expiry(ZSET)  KEYS[3]=board:offers:{tripId}
 * ARGV[1]=tripId  ARGV[2]=nowMs  ARGV[3]=board:cell: prefijo
 * Devuelve una TABLA Lua {outcome, offerCount, windowEpoch}:
 *  - board no existe                            → {-2}                  (id colgado: el barrido lo limpia).
 *  - status!=='OPEN' OR expiresAt>nowMs (no-op) → {-1}.
 *  - expirado                                   → {offerCount, expiresAt} (offerCount=HLEN>=0).
 * H8 — devuelve `expiresAt` (windowEpoch, leído in-script) para que el barrido arme la dedupKey SIN
 * un `getBoard` extra por board por tick.
 */
const EXPIRE_IF_OPEN_SCRIPT = `${LUA_LOAD_BOARD('return {-2}')}
if board['status'] ~= 'OPEN' then return {-1} end
if tonumber(board['expiresAt']) > tonumber(ARGV[2]) then return {-1} end
board['status'] = 'EXPIRED'
${LUA_SAVE_PRESERVE_TTL}
redis.call('ZREM', KEYS[2], ARGV[1])
if board['originCell'] then redis.call('ZREM', ARGV[3] .. board['originCell'], ARGV[1]) end
return {redis.call('HLEN', KEYS[3]), tonumber(board['expiresAt'])}
`;

/**
 * cancelIfOpen — cancelación condicional ATÓMICA (CAS OPEN→CANCELLED, espejo de expireIfOpen). Compite
 * limpio con el claim del accept y el expire: si otro CAS ya cerró el board, esto es no-op (0) y NUNCA
 * pisa un CLOSED_MATCHED/EXPIRED (el read-then-write de setBoardStatus sí podía pisarlo en la
 * micro-ventana). Limpia los índices de barrido (expiry ZSET + celda) igual que los otros cierres.
 * KEYS[1]=board:{tripId}  KEYS[2]=board:expiry(ZSET)  ARGV[1]=tripId  ARGV[2]=board:cell: prefijo
 * Devuelve 1 si canceló; 0 si no (board ausente o ya no OPEN).
 */
const CANCEL_IF_OPEN_SCRIPT = `${LUA_LOAD_BOARD('return 0')}
if board['status'] ~= 'OPEN' then return 0 end
board['status'] = 'CANCELLED'
${LUA_SAVE_PRESERVE_TTL}
redis.call('ZREM', KEYS[2], ARGV[1])
if board['originCell'] then redis.call('ZREM', ARGV[2] .. board['originCell'], ARGV[1]) end
return 1
`;

/**
 * submitOfferIfOpen — HSET de la oferta SOLO si el board sigue OPEN (cierra el edge oferta-tras-cierre).
 * KEYS[1]=board:{tripId}  KEYS[2]=board:offers:{tripId}
 * ARGV[1]=driverId  ARGV[2]=offerJson  ARGV[3]=ttl(s)
 * IF board no existe OR status!=='OPEN' → devuelve 0 (rechazo). ELSE HSET + EXPIRE, devuelve 1.
 */
const SUBMIT_OFFER_IF_OPEN_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local board = cjson.decode(raw)
if board['status'] ~= 'OPEN' then return 0 end
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1
`;

/**
 * lapseAndAccept — A5: flip en LOTE de las ofertas en UNA pasada server-side (reemplaza N×setOfferStatus).
 * KEYS[1]=board:offers:{tripId}  ARGV[1]=winnerDriverId ('' = sin ganador, caso sweep)  ARGV[2]=nowMs
 * Recorre el HASH (HGETALL); para cada oferta:
 *  - driver == winner            → status='ACCEPTED'
 *  - else status=='PENDING'      → status='LAPSED'
 *  - else                        → sin cambios (no re-escribe LAPSED/STALE/WITHDRAWN ya muertas)
 * Devuelve el #ofertas modificadas. No-op (0) si el HASH no existe.
 */
const LAPSE_AND_ACCEPT_SCRIPT = `
local all = redis.call('HGETALL', KEYS[1])
local winner = ARGV[1]
local now = tonumber(ARGV[2])
local changed = 0
for i = 1, #all, 2 do
  local driverId = all[i]
  local offer = cjson.decode(all[i + 1])
  local newStatus = nil
  if winner ~= '' and driverId == winner then
    newStatus = 'ACCEPTED'
  elseif offer['status'] == 'PENDING' then
    newStatus = 'LAPSED'
  end
  if newStatus ~= nil and offer['status'] ~= newStatus then
    offer['status'] = newStatus
    offer['updatedAt'] = now
    redis.call('HSET', KEYS[1], driverId, cjson.encode(offer))
    changed = changed + 1
  end
end
return changed
`;

export class RedisOfferBoardStore implements OfferBoardStore {
  constructor(private readonly redis: Redis) {}

  private boardKey(tripId: string): string {
    return `${BOARD_PREFIX}${tripId}`;
  }
  private offersKey(tripId: string): string {
    return `${OFFERS_PREFIX}${tripId}`;
  }
  private cellKey(cell: string): string {
    return `${CELL_PREFIX}${cell}`;
  }

  async saveBoard(board: OfferBoard, ttlSeconds: number): Promise<void> {
    const pipeline = this.redis.multi();
    pipeline.set(this.boardKey(board.tripId), JSON.stringify(board), 'EX', ttlSeconds);
    if (board.status === 'OPEN') {
      // H8 — el board entra al ZSET scoreado por su vencimiento → el barrido lo lee por rango DUE.
      pipeline.zadd(EXPIRY_ZSET, board.expiresAt, board.tripId);
      // A3/H11 — y al índice inverso celda→board (ZSET scoreado por expiresAt, espejo de board:expiry),
      // para que listOpenBidsNear lo encuentre por k-ring (ZRANGEBYSCORE) y un board muerto por TTL se
      // auto-excluya/purgue al leer.
      pipeline.zadd(this.cellKey(board.originCell), board.expiresAt, board.tripId);
    } else {
      pipeline.zrem(EXPIRY_ZSET, board.tripId);
      pipeline.zrem(this.cellKey(board.originCell), board.tripId);
    }
    await pipeline.exec();
  }

  async getBoard(tripId: string): Promise<OfferBoard | null> {
    const raw = await this.redis.get(this.boardKey(tripId));
    if (!raw) return null;
    return RedisOfferBoardStore.parseBoard(raw);
  }

  async setBoardStatus(tripId: string, status: BoardStatus): Promise<void> {
    const raw = await this.redis.get(this.boardKey(tripId));
    if (!raw) return;
    const board = RedisOfferBoardStore.parseBoard(raw);
    board.status = status;
    const ttl = await this.redis.ttl(this.boardKey(tripId));
    const pipeline = this.redis.multi();
    // Conserva el TTL restante; si ya no tiene (-1/-2), persiste sin expiración (el barrido lo cerró).
    if (ttl > 0) {
      pipeline.set(this.boardKey(tripId), JSON.stringify(board), 'EX', ttl);
    } else {
      pipeline.set(this.boardKey(tripId), JSON.stringify(board));
    }
    // H8 — re-indexa por vencimiento (ZADD score=expiresAt) si vuelve a OPEN; ZREM si se cerró.
    // A3/H11 — y el índice de celda (ZSET score=expiresAt): ZADD si OPEN, ZREM si se cerró (p.ej.
    // cancelBoard → CANCELLED).
    if (status === 'OPEN') {
      pipeline.zadd(EXPIRY_ZSET, board.expiresAt, tripId);
      pipeline.zadd(this.cellKey(board.originCell), board.expiresAt, tripId);
    } else {
      pipeline.zrem(EXPIRY_ZSET, tripId);
      pipeline.zrem(this.cellKey(board.originCell), tripId);
    }
    await pipeline.exec();
  }

  async saveOffer(offer: Offer, ttlSeconds: number): Promise<void> {
    const pipeline = this.redis.multi();
    pipeline.hset(this.offersKey(offer.tripId), offer.driverId, JSON.stringify(offer));
    pipeline.expire(this.offersKey(offer.tripId), ttlSeconds);
    await pipeline.exec();
  }

  async getOffer(tripId: string, driverId: string): Promise<Offer | null> {
    const raw = await this.redis.hget(this.offersKey(tripId), driverId);
    if (!raw) return null;
    return JSON.parse(raw) as Offer;
  }

  async listOffers(tripId: string): Promise<Offer[]> {
    const all = await this.redis.hgetall(this.offersKey(tripId));
    return Object.values(all).map((raw) => JSON.parse(raw) as Offer);
  }

  async setOfferStatus(tripId: string, driverId: string, status: OfferStatus): Promise<void> {
    const raw = await this.redis.hget(this.offersKey(tripId), driverId);
    if (!raw) return;
    const offer = JSON.parse(raw) as Offer;
    offer.status = status;
    offer.updatedAt = Date.now();
    await this.redis.hset(this.offersKey(tripId), driverId, JSON.stringify(offer));
  }

  async clearOffers(tripId: string): Promise<void> {
    // DEL es atómico: el HASH de ofertas de la ventana previa desaparece de una. No-op si no existe.
    await this.redis.del(this.offersKey(tripId));
  }

  async dueBoardIds(nowMs: number): Promise<string[]> {
    // H8 — SOLO los boards cuya ventana ya venció (score <= now). Range-read O(due), no SMEMBERS-all.
    return this.redis.zrangebyscore(EXPIRY_ZSET, '-inf', nowMs);
  }

  async removeOpenId(tripId: string): Promise<void> {
    await this.redis.zrem(EXPIRY_ZSET, tripId);
  }

  async listOpenBoards(nowMs: number): Promise<OfferBoard[]> {
    // H8 — membresía OPEN = boards aún NO vencidos (score > now). Range-read, no SMEMBERS-all.
    const ids = await this.redis.zrangebyscore(EXPIRY_ZSET, `(${nowMs}`, '+inf');
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(ids.map((id) => this.boardKey(id)));
    const boards: OfferBoard[] = [];
    for (const raw of raws) {
      if (!raw) continue;
      const board = RedisOfferBoardStore.parseBoard(raw);
      if (board.status === 'OPEN') boards.push(board);
    }
    return boards;
  }

  async boardsInCells(cells: string[]): Promise<OfferBoard[]> {
    if (cells.length === 0) return [];
    const now = Date.now();
    // A3/H11 — por cada celda del k-ring: PODA los miembros muertos (score < now, board ya vencido por
    // TTL pero colgado en el ZSET) con ZREMRANGEBYSCORE, y LEE solo los AÚN vigentes (score >= now) con
    // ZRANGEBYSCORE. Así el índice de celda queda acotado (se auto-purga en cada lectura) y un board
    // muerto por TTL NUNCA se devuelve. El MGET de la unión mantiene el null-skip belt-and-suspenders.
    const pipeline = this.redis.multi();
    for (const c of cells) {
      pipeline.zremrangebyscore(this.cellKey(c), '-inf', `(${now}`);
      pipeline.zrangebyscore(this.cellKey(c), now, '+inf');
    }
    const results = await pipeline.exec();
    if (!results) return [];
    const idSet = new Set<string>();
    // Las respuestas vienen en pares [prune, range] por celda; tomamos solo el ZRANGEBYSCORE (impares).
    for (let i = 1; i < results.length; i += 2) {
      const entry = results[i];
      if (!entry) continue;
      const value = entry[1];
      if (Array.isArray(value)) {
        for (const id of value as string[]) idSet.add(id);
      }
    }
    if (idSet.size === 0) return [];
    const ids = [...idSet];
    const raws = await this.redis.mget(ids.map((id) => this.boardKey(id)));
    const boards: OfferBoard[] = [];
    for (const raw of raws) {
      if (!raw) continue;
      boards.push(RedisOfferBoardStore.parseBoard(raw));
    }
    return boards;
  }

  // ── Transiciones atómicas (CAS vía Lua) ────────────────────────────────────────────────────────

  async claimBoardForAccept(
    tripId: string,
    driverId: string,
    claimedAtMs: number,
  ): Promise<ClaimResult> {
    const res = (await this.redis.eval(
      CLAIM_FOR_ACCEPT_SCRIPT,
      3,
      this.boardKey(tripId),
      EXPIRY_ZSET,
      MATCHED_ZSET,
      tripId,
      driverId,
      String(claimedAtMs),
      CELL_PREFIX,
    )) as string;
    if (res === '') return { claimed: false, status: null };
    if (res === 'CLAIMED') return { claimed: true, status: 'CLOSED_MATCHED' };
    return { claimed: false, status: res as BoardStatus };
  }

  async revertClaim(tripId: string): Promise<void> {
    await this.redis.eval(
      REVERT_CLAIM_SCRIPT,
      3,
      this.boardKey(tripId),
      EXPIRY_ZSET,
      MATCHED_ZSET,
      tripId,
      CELL_PREFIX,
    );
  }

  async markMatchEmitted(tripId: string): Promise<void> {
    await this.redis.eval(MARK_MATCH_EMITTED_SCRIPT, 2, this.boardKey(tripId), MATCHED_ZSET, tripId);
  }

  async matchedUnemittedBoards(olderThanMs: number): Promise<OfferBoard[]> {
    // H8 — solo los matched cuyo claim es MÁS VIEJO que el grace (score <= olderThanMs): range-read,
    // no SMEMBERS-all. Los recién matcheados (que el happy-path está por drenar) quedan fuera del rango.
    const ids = await this.redis.zrangebyscore(MATCHED_ZSET, '-inf', olderThanMs);
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(ids.map((id) => this.boardKey(id)));
    const boards: OfferBoard[] = [];
    for (const [i, id] of ids.entries()) {
      const raw = raws[i];
      if (!raw) {
        // El board ya no existe (TTL de Redis): limpia el id colgado del matched-zset para no re-escanear.
        await this.redis.zrem(MATCHED_ZSET, id);
        continue;
      }
      const board = RedisOfferBoardStore.parseBoard(raw);
      // Solo los CLOSED_MATCHED sin la marca necesitan reconciliación (un revert ya los sacó del zset).
      if (board.status === 'CLOSED_MATCHED' && board.matchEmitted !== true) boards.push(board);
    }
    return boards;
  }

  async cancelIfOpen(tripId: string): Promise<boolean> {
    const res = (await this.redis.eval(
      CANCEL_IF_OPEN_SCRIPT,
      2,
      this.boardKey(tripId),
      EXPIRY_ZSET,
      tripId,
      CELL_PREFIX,
    )) as number;
    return res === 1;
  }

  async expireIfOpen(tripId: string, nowMs: number): Promise<ExpireResult> {
    const res = (await this.redis.eval(
      EXPIRE_IF_OPEN_SCRIPT,
      3,
      this.boardKey(tripId),
      EXPIRY_ZSET,
      this.offersKey(tripId),
      tripId,
      String(nowMs),
      CELL_PREFIX,
    )) as [number] | [number, number];
    const outcome = res[0];
    // {-2} = board no existe (id colgado, el barrido lo limpia); {-1} = no OPEN o aún vigente (raza, no-op).
    if (outcome < 0) {
      return { expired: false, offerCount: 0, windowEpoch: null, boardExists: outcome !== -2 };
    }
    // {offerCount, windowEpoch} — el Lua devolvió el epoch leído in-script (sin getBoard extra).
    return { expired: true, offerCount: outcome, windowEpoch: res[1] ?? null, boardExists: true };
  }

  async submitOfferIfOpen(offer: Offer, ttlSeconds: number): Promise<boolean> {
    const res = (await this.redis.eval(
      SUBMIT_OFFER_IF_OPEN_SCRIPT,
      2,
      this.boardKey(offer.tripId),
      this.offersKey(offer.tripId),
      offer.driverId,
      JSON.stringify(offer),
      String(ttlSeconds),
    )) as number;
    return res === 1;
  }

  async lapseAndAccept(tripId: string, winnerDriverId: string | null): Promise<number> {
    const res = (await this.redis.eval(
      LAPSE_AND_ACCEPT_SCRIPT,
      1,
      this.offersKey(tripId),
      winnerDriverId ?? '',
      String(Date.now()),
    )) as number;
    return res;
  }

  private static parseBoard(raw: string): OfferBoard {
    const parsed = JSON.parse(raw) as OfferBoard;
    return { ...parsed, vehicleType: parsed.vehicleType ?? VehicleType.CAR };
  }
}
