/**
 * Integración del OfferBoardStore sobre Redis REAL — H8 (barrido due-only sobre sorted-sets).
 *
 * Ejercita contra un Redis vivo: el ZADD<expiresAt> en `board:expiry`, el ZRANGEBYSCORE due/no-due, el
 * Lua de claim (ZREM expiry → ZADD<claimedAtMs> matched) y de expire (devuelve windowEpoch in-script),
 * y la reconciliación por grace sobre `board:matched`. Prueba la afirmación de escalabilidad: con N
 * boards NO vencidos, `dueBoardIds` devuelve O(due)=0 ids (un range-read), no los N (lo que antes era
 * SMEMBERS-all O(N)).
 *
 * Se ejecuta solo con RUN_INTEGRATION=1 (requiere el dev-stack: REDIS_URL, default redis://localhost:6379).
 * Excluido por defecto en vitest.config.ts para mantener `pnpm test` verde sin dependencias externas.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Redis from 'ioredis';
import { toH3, DISPATCH_H3_RESOLUTION } from '@veo/utils';
import { VehicleType } from '@veo/shared-types';
import { RedisOfferBoardStore } from './redis-offer-board.store';
import type { OfferBoard } from './offer-board.port';

const ORIGIN = { lat: -12.0464, lon: -77.0428 };
const ORIGIN_CELL = toH3(ORIGIN, DISPATCH_H3_RESOLUTION);

function board(
  tripId: string,
  expiresAt: number,
  status: OfferBoard['status'] = 'OPEN',
): OfferBoard {
  return {
    tripId,
    passengerId: 'p1',
    bidCents: 700,
    vehicleType: VehicleType.CAR,
    origin: ORIGIN,
    destination: { lat: -12.0931, lon: -77.0465 },
    distanceMeters: 4200,
    durationSeconds: 900,
    originCell: ORIGIN_CELL,
    status,
    expiresAt,
    negotiationSeq: 1,
    specialRequests: [],
  };
}

describe('RedisOfferBoardStore · integración H8 (Redis real)', () => {
  let redis: Redis;
  let store: RedisOfferBoardStore;

  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    store = new RedisOfferBoardStore(redis);
  });

  afterAll(async () => {
    const cellKeys = await redis?.keys('board:cell:*');
    if (cellKeys?.length) await redis.del(...cellKeys);
    await redis?.del('board:expiry', 'board:matched');
    await redis?.quit();
  });

  beforeEach(async () => {
    // Limpia índices + cualquier board:* de corridas previas (boards son efímeros).
    const keys = await redis.keys('board:*');
    if (keys.length) await redis.del(...keys);
  });

  it('saveBoard hace ZADD<expiresAt> en board:expiry; dueBoardIds lee SOLO los vencidos por rango', async () => {
    const now = Date.now();
    await store.saveBoard(board('due', now - 1_000), 90); // vencido
    await store.saveBoard(board('live', now + 60_000), 90); // vigente

    // El índice es un ZSET con score = expiresAt.
    expect(await redis.type('board:expiry')).toBe('zset');
    expect(await redis.zscore('board:expiry', 'due')).toBe(String(now - 1_000));

    // Range-read: SOLO el vencido (prueba O(due), no O(total)).
    expect(await store.dueBoardIds(now)).toEqual(['due']);
    // Membresía OPEN: SOLO el vigente (no vencido).
    expect((await store.listOpenBoards(now)).map((b) => b.tripId)).toEqual(['live']);
  });

  it('con N boards NO-due, dueBoardIds devuelve O(due)=0 ids (un range-read, no SMEMBERS-all O(N))', async () => {
    const now = Date.now();
    for (let i = 0; i < 200; i++) await store.saveBoard(board(`live-${i}`, now + 60_000), 90);
    // El zset tiene 200 entradas pero el rango DUE no devuelve NINGUNA: el barrido no pagaría O(N).
    expect(await redis.zcard('board:expiry')).toBe(200);
    expect(await store.dueBoardIds(now)).toEqual([]);
  });

  it('expireIfOpen (Lua) marca EXPIRED, ZREM del expiry-zset y DEVUELVE el windowEpoch in-script', async () => {
    const now = Date.now();
    const expiresAt = now - 1_000;
    await store.saveBoard(board('t1', expiresAt), 90);
    await store.saveOffer(
      {
        tripId: 't1',
        driverId: 'd1',
        kind: 'ACCEPT_PRICE',
        priceCents: 700,
        etaSeconds: 0,
        status: 'PENDING',
        updatedAt: now,
      },
      90,
    );

    const res = await store.expireIfOpen('t1', now);
    expect(res.expired).toBe(true);
    expect(res.offerCount).toBe(1);
    // El epoch lo devolvió el Lua (sin getBoard extra del barrido).
    expect(res.windowEpoch).toBe(expiresAt);
    expect(res.boardExists).toBe(true);
    // Salió del índice de barrido (ZREM dentro del script).
    expect(await store.dueBoardIds(now)).toEqual([]);
    expect((await store.getBoard('t1'))?.status).toBe('EXPIRED');
  });

  it('expireIfOpen sobre un board inexistente (id colgado) → boardExists=false (el barrido lo limpia)', async () => {
    const now = Date.now();
    // Id colgado: entrada en el zset pero sin la key del board (espeja un TTL de Redis ya pasado).
    await redis.zadd('board:expiry', now - 1_000, 'gone');
    const res = await store.expireIfOpen('gone', now);
    expect(res.expired).toBe(false);
    expect(res.boardExists).toBe(false);
  });

  it('claim (Lua) mueve del expiry-zset al matched-zset con score=claimedAtMs; reconciler por grace', async () => {
    const now = Date.now();
    await store.saveBoard(board('m1', now + 60_000), 90);

    const claimedAt = now;
    const claim = await store.claimBoardForAccept('m1', 'd1', claimedAt);
    expect(claim.claimed).toBe(true);
    // Salió de expiry, entró a matched con score = claimedAtMs.
    expect(await redis.zscore('board:expiry', 'm1')).toBeNull();
    expect(await redis.zscore('board:matched', 'm1')).toBe(String(claimedAt));
    expect(await redis.type('board:matched')).toBe('zset');

    // Reconciler: dentro del grace (cutoff < claimedAt) NO lo devuelve; pasado el grace SÍ.
    expect(await store.matchedUnemittedBoards(claimedAt - 1)).toHaveLength(0);
    expect((await store.matchedUnemittedBoards(claimedAt + 1)).map((b) => b.tripId)).toEqual([
      'm1',
    ]);

    // markMatchEmitted lo saca del matched-zset.
    await store.markMatchEmitted('m1');
    expect(await redis.zscore('board:matched', 'm1')).toBeNull();
  });

  it('A5 · lapseAndAccept (Lua) flipea winner→ACCEPTED y resto PENDING→LAPSED en UN round-trip', async () => {
    const now = Date.now();
    await store.saveBoard(board('a1', now + 60_000), 90);
    const off = (driverId: string, status: 'PENDING' | 'STALE') => ({
      tripId: 'a1',
      driverId,
      kind: 'ACCEPT_PRICE' as const,
      priceCents: 700,
      etaSeconds: 0,
      status,
      updatedAt: now,
    });
    await store.saveOffer(off('d1', 'PENDING'), 90); // ganador
    await store.saveOffer(off('d2', 'PENDING'), 90); // → LAPSED
    await store.saveOffer(off('d3', 'STALE'), 90); // muerta: NO se toca

    const changed = await store.lapseAndAccept('a1', 'd1');
    expect(changed).toBe(2); // d1→ACCEPTED, d2→LAPSED (d3 STALE intacta)
    expect((await store.getOffer('a1', 'd1'))?.status).toBe('ACCEPTED');
    expect((await store.getOffer('a1', 'd2'))?.status).toBe('LAPSED');
    expect((await store.getOffer('a1', 'd3'))?.status).toBe('STALE');
  });

  it('A5 · lapseAndAccept con winner=null caduca TODAS las PENDING (caso sweep)', async () => {
    const now = Date.now();
    await store.saveBoard(board('a2', now + 60_000), 90);
    await store.saveOffer(
      {
        tripId: 'a2',
        driverId: 'd1',
        kind: 'ACCEPT_PRICE',
        priceCents: 700,
        etaSeconds: 0,
        status: 'PENDING',
        updatedAt: now,
      },
      90,
    );
    await store.saveOffer(
      {
        tripId: 'a2',
        driverId: 'd2',
        kind: 'COUNTER',
        priceCents: 900,
        etaSeconds: 0,
        status: 'PENDING',
        updatedAt: now,
      },
      90,
    );
    const changed = await store.lapseAndAccept('a2', null);
    expect(changed).toBe(2);
    expect((await store.getOffer('a2', 'd1'))?.status).toBe('LAPSED');
    expect((await store.getOffer('a2', 'd2'))?.status).toBe('LAPSED');
  });

  it('revertClaim re-ZADD al expiry-zset (score=expiresAt) y ZREM del matched-zset', async () => {
    const now = Date.now();
    const expiresAt = now + 60_000;
    await store.saveBoard(board('r1', expiresAt), 90);
    await store.claimBoardForAccept('r1', 'd1', now);

    await store.revertClaim('r1');
    expect((await store.getBoard('r1'))?.status).toBe('OPEN');
    // Volvió al índice de barrido con su expiry original.
    expect(await redis.zscore('board:expiry', 'r1')).toBe(String(expiresAt));
    expect(await redis.zscore('board:matched', 'r1')).toBeNull();
  });

  // ── A3/H11: índice inverso celda→board, ahora ZSET<expiresAt> (ZRANGEBYSCORE + MGET, auto-acotado) ──
  it('A3/H11 · saveBoard ZADD<expiresAt> al board:cell:<originCell>; boardsInCells lee SOLO esa celda', async () => {
    const now = Date.now();
    const expiresAt = now + 60_000;
    const cellKey = `board:cell:${ORIGIN_CELL}`;
    await store.saveBoard(board('c1', expiresAt), 90);

    // H11 — el índice de celda es un ZSET con el tripId scoreado por su expiresAt (no un SET plano).
    expect(await redis.type(cellKey)).toBe('zset');
    expect(await redis.zscore(cellKey, 'c1')).toBe(String(expiresAt));
    // boardsInCells del k-ring (la celda de origen) trae el board; una celda ajena no devuelve nada.
    expect((await store.boardsInCells([ORIGIN_CELL])).map((b) => b.tripId)).toEqual(['c1']);
    expect(await store.boardsInCells(['celda-ajena-sin-boards'])).toEqual([]);
  });

  it('A3/H11 · claim/expire/cancel hacen ZREM del cell-index (el tripId cerrado sale del ZSET de su celda)', async () => {
    const now = Date.now();
    const cellKey = `board:cell:${ORIGIN_CELL}`;

    // claim (OPEN→CLOSED_MATCHED) → ZREM.
    await store.saveBoard(board('cc-claim', now + 60_000), 90);
    expect(await redis.zscore(cellKey, 'cc-claim')).not.toBeNull();
    await store.claimBoardForAccept('cc-claim', 'd1', now);
    expect(await redis.zscore(cellKey, 'cc-claim')).toBeNull();

    // expire (OPEN→EXPIRED) → ZREM.
    await store.saveBoard(board('cc-exp', now - 1_000), 90);
    expect(await redis.zscore(cellKey, 'cc-exp')).not.toBeNull();
    await store.expireIfOpen('cc-exp', now);
    expect(await redis.zscore(cellKey, 'cc-exp')).toBeNull();

    // cancel (setBoardStatus OPEN→CANCELLED) → ZREM.
    await store.saveBoard(board('cc-cancel', now + 60_000), 90);
    expect(await redis.zscore(cellKey, 'cc-cancel')).not.toBeNull();
    await store.setBoardStatus('cc-cancel', 'CANCELLED');
    expect(await redis.zscore(cellKey, 'cc-cancel')).toBeNull();
  });

  it('A3/H11 · revertClaim hace ZADD<expiresAt> de vuelta al cell-index (el board re-abierto vuelve a ser candidato)', async () => {
    const now = Date.now();
    const expiresAt = now + 60_000;
    const cellKey = `board:cell:${ORIGIN_CELL}`;
    await store.saveBoard(board('cc-rev', expiresAt), 90);
    await store.claimBoardForAccept('cc-rev', 'd1', now);
    expect(await redis.zscore(cellKey, 'cc-rev')).toBeNull();

    await store.revertClaim('cc-rev');
    // Re-ZADD con score = expiresAt (no un 0/score-bogus): vuelve a salir por ZRANGEBYSCORE <now>..+inf.
    expect(await redis.zscore(cellKey, 'cc-rev')).toBe(String(expiresAt));
    expect((await store.boardsInCells([ORIGIN_CELL])).map((b) => b.tripId)).toContain('cc-rev');
  });

  it('A3/H11 · boardsInCells devuelve SOLO los no-vencidos (score>=now) y PURGA el fantasma muerto por TTL', async () => {
    const now = Date.now();
    const cellKey = `board:cell:${ORIGIN_CELL}`;

    // Board vivo (score futuro) + un tripId FANTASMA inyectado con score pasado (board ya muerto por TTL,
    // sin su key board:<id>) — simula la fuga del SET viejo: quedaba colgado para siempre.
    await store.saveBoard(board('alive', now + 60_000), 90);
    await redis.zadd(cellKey, now - 10_000, 'phantom-dead');
    expect(await redis.zcard(cellKey)).toBe(2);

    // boardsInCells: el fantasma (score<now) NO se devuelve...
    const result = (await store.boardsInCells([ORIGIN_CELL])).map((b) => b.tripId);
    expect(result).toEqual(['alive']);
    // ...y además fue PODADO del ZSET (ZREMRANGEBYSCORE -inf <now>) → índice acotado.
    expect(await redis.zscore(cellKey, 'phantom-dead')).toBeNull();
    expect(await redis.zcard(cellKey)).toBe(1);
  });
});
