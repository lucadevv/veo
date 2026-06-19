/**
 * ReadModelService — read-model CQRS en Redis para los LISTADOS que el downstream no expone
 * (no existe GET /trips ni listado de conductores en los servicios). Se alimenta del stream Kafka
 * (eventos de dominio reales, NO datos inventados) y sirve listados con filtros + paginación cursor.
 *
 * Índices (sorted sets, score = epoch ms):
 *  - trips:      bff:rm:trips  + por estado/driver/passenger.
 *  - drivers:    bff:rm:drivers + por estado.
 * Detalle de cada entidad en un hash bff:rm:trip:{id} / bff:rm:driver:{id}.
 */
import { Injectable, Inject } from '@nestjs/common';
import type Redis from 'ioredis';
import type { TripStatus } from '@veo/api-client';
import { REDIS } from '../infra/tokens';

const TRIPS = 'bff:rm:trips';
const DRIVERS = 'bff:rm:drivers';
const TTL_SECONDS = 60 * 60 * 24 * 14; // retención de 14 días en el read-model

/**
 * Watermark de monotonía SOLO del eje status (campo interno del hash, NO dato de dominio del panel).
 * Separado del updatedAt general a propósito: el eje rating (driver.flagged → averageRating, con su
 * propio updatedAt=Date.now()) NO debe bloquearse nunca por este fence.
 */
const STATUS_WATERMARK_FIELD = 'statusUpdatedAt' as const;

/** Normaliza un valor de hash Redis (ausente o "") a null; cualquier string no vacío se preserva. */
function nonEmptyOrNull(value: string | undefined): string | null {
  return value !== undefined && value !== '' ? value : null;
}

/**
 * Sentinel para distinguir "campo ausente" (conservar el actual) de "explicit null" (re-aprobación
 * limpia el motivo → ""). El prefijo NUL () garantiza que NINGÚN status/reason/id/userId
 * legítimo (todos texto imprimible) pueda colisionar con él. Viaja como dato por ARGV y se compara
 * por igualdad exacta en Lua — NO es string mágico de dominio en TS, es protocolo de transporte JS↔Lua.
 */
const ABSENT = '\u0000__veo_absent__' as const;

/**
 * CAS atómico del upsert de conductor (FIX CRÍTICO TOCTOU multi-réplica).
 *
 * Toda la lógica read-compare-write vive acá y corre atómica dentro de Redis (un solo hilo), así que
 * dos `upsertDriver` concurrentes sobre el mismo hash desde réplicas distintas (admin-bff replicas:2,
 * HPA→10; eventos cross-topic del mismo driver caen en pods distintos del mismo consumer group) NO
 * pueden interleavear read/write → se elimina el lost-update. El compare-in-JS previo leía el hash
 * FUERA del MULTI/EXEC y sin WATCH: TOCTOU real bajo concurrencia.
 *
 * KEYS[1] = hash del driver (bff:rm:driver:{id})
 * KEYS[2] = zset global de recencia (bff:rm:drivers)
 *
 * ARGV (todos string; el caller ya parseó a número lo que debe ser número, NUNCA os.time/no-determinismo):
 *  [1]  driversPrefix      → para construir los índices por status DENTRO del Lua (mono-nodo, no cluster)
 *  [2]  id
 *  [3]  status             | ABSENT  (eje status)
 *  [4]  backgroundCheckStatus | ABSENT (eje status)
 *  [5]  rejectionReason    | ABSENT  (eje status; "" explícito = limpiar motivo)
 *  [6]  averageRating      | ABSENT  (eje NO-status; "" explícito = null)
 *  [7]  userId             | ABSENT  (eje NO-status)
 *  [8]  updatedAt          (incoming, string ISO — lo escribimos tal cual si aplica)
 *  [9]  touchesStatus      ('1' | '0')
 *  [10] incomingStatusTs   (número ya parseado en JS; '' si NaN/ausente)
 *  [11] incomingScore      (número ya parseado en JS: score de recencia entrante)
 *  [12] ttlSeconds         (número)
 *  [13] statusWatermarkField (nombre del campo watermark en el hash)
 *  [14] absent             (el sentinel, para comparar)
 *
 * Devuelve: 1 = status aplicado · 0 = status entrante stale/descartado · 2 = solo eje no-status.
 */
const UPSERT_DRIVER_CAS = `
local hashKey   = KEYS[1]
local zGlobal   = KEYS[2]
local prefix    = ARGV[1]
local id        = ARGV[2]
local inStatus  = ARGV[3]
local inBg      = ARGV[4]
local inReason  = ARGV[5]
local inRating  = ARGV[6]
local inUserId  = ARGV[7]
local inUpdated = ARGV[8]
local touches   = ARGV[9] == '1'
local inTsRaw   = ARGV[10]
local inScore   = tonumber(ARGV[11])
local ttl       = tonumber(ARGV[12])
local wmField   = ARGV[13]
local ABSENT    = ARGV[14]

-- 1) Estado actual: watermark + status (para el zrem del índice previo).
local curStatus    = redis.call('HGET', hashKey, 'status')
local curWatermark = redis.call('HGET', hashKey, wmField)
local curUpdated   = redis.call('HGET', hashKey, 'updatedAt')

-- 2) Staleness del eje status: <= para idempotencia ante redelivery exacta.
--    Watermark ausente → NO stale (fail-open: primer evento de status siembra).
local incomingTs = tonumber(inTsRaw)
local watermarkTs = tonumber(curWatermark)
local statusIsStale = false
if touches and watermarkTs ~= nil and incomingTs ~= nil and incomingTs <= watermarkTs then
  statusIsStale = true
end

local applyStatus = touches and (not statusIsStale)

-- 3) Eje NO-status: presente (≠ ABSENT) → set; ausente → conservar.
--    El fence NUNCA toca estos.
if inUserId ~= ABSENT then
  redis.call('HSET', hashKey, 'userId', inUserId)
end
if inRating ~= ABSENT then
  -- "" explícito → null en el read-model (toDriver lo normaliza). Aún así lo persistimos como "".
  redis.call('HSET', hashKey, 'averageRating', inRating)
end

-- 4) Eje status (status + backgroundCheckStatus + rejectionReason): solo si aplica (no stale).
if applyStatus then
  if inStatus ~= ABSENT then
    redis.call('HSET', hashKey, 'status', inStatus)
  end
  if inBg ~= ABSENT then
    redis.call('HSET', hashKey, 'backgroundCheckStatus', inBg)
  end
  -- rejectionReason: ABSENT conserva; cualquier otro valor (incl. "") se escribe.
  if inReason ~= ABSENT then
    redis.call('HSET', hashKey, 'rejectionReason', inReason)
  end
  -- avanzar watermark = incomingStatusTs (epoch ms NUMÉRICO, no el ISO): así la comparación del
  -- paso 2 (tonumber) es determinista. Un watermark legacy en ISO → tonumber=nil → fail-open (se
  -- re-siembra como número en el primer evento de status post-deploy: degradación segura).
  redis.call('HSET', hashKey, wmField, inTsRaw)
end

-- 5) updatedAt + score de recencia (FIX regresión de recencia):
--    - eje no-status (rating): updatedAt entrante = actividad legítima → usar.
--    - eje status NO-stale: usar el entrante.
--    - eje status STALE: NO regresar (conservar el actual).
local scoreToUse = inScore
local updatedToUse = inUpdated
if touches and statusIsStale then
  -- conservamos updatedAt/score actuales; si no hay actual, no regresamos nada nuevo.
  updatedToUse = curUpdated
  local curScore = redis.call('ZSCORE', zGlobal, id)
  if curScore ~= false then
    scoreToUse = tonumber(curScore)
  else
    scoreToUse = inScore
  end
end
if updatedToUse ~= nil and updatedToUse ~= false then
  redis.call('HSET', hashKey, 'updatedAt', updatedToUse)
end
-- id e identidad mínima siempre presentes.
redis.call('HSET', hashKey, 'id', id)
redis.call('EXPIRE', hashKey, ttl)

-- 7) zadd global de recencia con el score NO-regresado.
redis.call('ZADD', zGlobal, scoreToUse, id)

-- 6) Índices por status: SOLO cuando hay un status REAL que aplicar (applyStatus).
--    En un evento de rating puro (touches=false) NO se tocan los índices → no se siembra 'UNKNOWN'.
if applyStatus then
  local newStatus = inStatus
  if newStatus == ABSENT then
    -- touchesStatus puede venir por backgroundCheckStatus sin status: el status efectivo es el actual.
    newStatus = curStatus
  end
  if newStatus ~= nil and newStatus ~= false then
    redis.call('ZADD', prefix .. ':s:' .. newStatus, scoreToUse, id)
    if curStatus ~= nil and curStatus ~= false and curStatus ~= newStatus then
      redis.call('ZREM', prefix .. ':s:' .. curStatus, id)
    end
  end
end

if not touches then
  return 2
end
if statusIsStale then
  return 0
end
return 1
`;

export interface TripRecord {
  id: string;
  status: TripStatus;
  passengerId: string;
  driverId: string | null;
  fareCents: number;
  createdAt: string;
}

export interface DriverRecord {
  id: string;
  userId: string;
  status: string;
  averageRating: number | null;
  backgroundCheckStatus: string;
  /** Motivo del último rechazo de antecedentes; null si no está rechazado o no se dio motivo. */
  rejectionReason: string | null;
  updatedAt: string;
}

export interface TripListFilter {
  status?: TripStatus;
  driverId?: string;
  passengerId?: string;
}

export interface DriverListFilter {
  status?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

@Injectable()
export class ReadModelService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  // ── Proyección de viajes ──

  async upsertTrip(rec: TripRecord): Promise<void> {
    const prev = await this.redis.hget(`bff:rm:trip:${rec.id}`, 'status');
    const score = Date.parse(rec.createdAt) || Date.now();
    const pipe = this.redis.multi();
    pipe.hset(`bff:rm:trip:${rec.id}`, {
      id: rec.id,
      status: rec.status,
      passengerId: rec.passengerId,
      driverId: rec.driverId ?? '',
      fareCents: String(rec.fareCents),
      createdAt: rec.createdAt,
    });
    pipe.expire(`bff:rm:trip:${rec.id}`, TTL_SECONDS);
    pipe.zadd(TRIPS, score, rec.id);
    pipe.zadd(`${TRIPS}:s:${rec.status}`, score, rec.id);
    if (prev && prev !== rec.status) pipe.zrem(`${TRIPS}:s:${prev}`, rec.id);
    pipe.zadd(`${TRIPS}:p:${rec.passengerId}`, score, rec.id);
    if (rec.driverId) pipe.zadd(`${TRIPS}:d:${rec.driverId}`, score, rec.id);
    await pipe.exec();
  }

  /** Actualiza estado (y opcionalmente driver) de un viaje ya proyectado. */
  async patchTrip(id: string, status: TripStatus, driverId?: string): Promise<void> {
    const current = await this.redis.hgetall(`bff:rm:trip:${id}`);
    if (!current.id) {
      // Aún no proyectado (evento fuera de orden): creamos un registro mínimo.
      await this.upsertTrip({
        id,
        status,
        passengerId: current.passengerId ?? '',
        driverId: driverId ?? current.driverId ?? null,
        fareCents: Number(current.fareCents ?? 0),
        createdAt: current.createdAt ?? new Date().toISOString(),
      });
      return;
    }
    const score = Date.parse(current.createdAt ?? '') || Date.now();
    const prevStatus = current.status;
    const pipe = this.redis.multi();
    pipe.hset(`bff:rm:trip:${id}`, 'status', status);
    if (driverId) {
      pipe.hset(`bff:rm:trip:${id}`, 'driverId', driverId);
      pipe.zadd(`${TRIPS}:d:${driverId}`, score, id);
    }
    pipe.zadd(`${TRIPS}:s:${status}`, score, id);
    if (prevStatus && prevStatus !== status) pipe.zrem(`${TRIPS}:s:${prevStatus}`, id);
    await pipe.exec();
  }

  async listTrips(
    filter: TripListFilter,
    cursor: string | null,
    limit: number,
  ): Promise<Page<TripRecord>> {
    const key = filter.status
      ? `${TRIPS}:s:${filter.status}`
      : filter.driverId
        ? `${TRIPS}:d:${filter.driverId}`
        : filter.passengerId
          ? `${TRIPS}:p:${filter.passengerId}`
          : TRIPS;
    const ids = await this.pageIds(key, cursor, limit);
    const records = await this.loadMany(ids.members, (id) => `bff:rm:trip:${id}`, this.toTrip);
    return { items: records, nextCursor: ids.nextCursor };
  }

  // ── Proyección de conductores ──

  // NOTA: el watermark statusUpdatedAt compara wall-clock de DOS servicios (fleet-service vs identity-service). Bajo clock-skew + transiciones de status casi-simultáneas del mismo driver desde ambos orígenes, el orden puede invertirse. Residual aceptado: read-model self-healing, identity-service es la autoridad. Fix real (reloj lógico / autoridad única de status) = initiative aparte.
  async upsertDriver(rec: Partial<DriverRecord> & { id: string }): Promise<void> {
    const keyHash = `bff:rm:driver:${rec.id}`;

    // Fence de monotonía POR-ASPECTO ejecutado como CAS ATÓMICO en Redis (ver UPSERT_DRIVER_CAS):
    // el read-compare-write entero corre dentro del script, eliminando el TOCTOU del compare-in-JS
    // previo bajo multi-réplica. Solo gobierna el eje status (status + backgroundCheckStatus +
    // rejectionReason); el eje rating (driver.flagged → averageRating) nunca se bloquea.
    const touchesStatus = rec.status !== undefined || rec.backgroundCheckStatus !== undefined;

    // El score/watermark se parsean a número ACÁ (JS) — el Lua NUNCA usa os.time ni nada no-determinista.
    const updatedAt = rec.updatedAt ?? new Date().toISOString();
    const incomingStatusTs = rec.updatedAt ? Date.parse(rec.updatedAt) : NaN;
    const incomingScore = Date.parse(updatedAt) || Date.now();

    // ARGV: ABSENT = "campo ausente" (conservar); cualquier otro valor (incl. "") = set explícito.
    // averageRating: undefined → ABSENT (conservar); null → "" (limpiar); número → su string.
    const ratingArg =
      rec.averageRating === undefined
        ? ABSENT
        : rec.averageRating === null
          ? ''
          : String(rec.averageRating);

    await this.redis.eval(
      UPSERT_DRIVER_CAS,
      2,
      keyHash,
      DRIVERS,
      DRIVERS, // prefix para construir los índices por status dentro del Lua
      rec.id,
      rec.status ?? ABSENT,
      rec.backgroundCheckStatus ?? ABSENT,
      rec.rejectionReason === undefined ? ABSENT : (rec.rejectionReason ?? ''),
      ratingArg,
      rec.userId ?? ABSENT,
      updatedAt,
      touchesStatus ? '1' : '0',
      Number.isFinite(incomingStatusTs) ? String(incomingStatusTs) : '',
      String(incomingScore),
      String(TTL_SECONDS),
      STATUS_WATERMARK_FIELD,
      ABSENT,
    );
  }

  /**
   * Saca un conductor del read-model (simétrico de upsertDriver): borra el hash de detalle y lo quita
   * del índice global Y del índice por estado actual. Lo usa el HARD purge (re-registro): tras borrar el
   * conductor aguas abajo, su proyección NO debe seguir apareciendo en los listados del panel.
   * Idempotente: un id ya ausente deja todo igual (hgetall vacío → no hay status que limpiar).
   * @returns true si existía proyección (se borró el hash), false si no había nada que sacar.
   */
  async removeDriver(id: string): Promise<boolean> {
    const keyHash = `bff:rm:driver:${id}`;
    const current = await this.redis.hgetall(keyHash);
    const pipe = this.redis.multi();
    pipe.del(keyHash);
    pipe.zrem(DRIVERS, id);
    // El miembro vive en el índice de SU estado actual; lo quitamos de ahí (si lo conocíamos).
    if (current.status) pipe.zrem(`${DRIVERS}:s:${current.status}`, id);
    await pipe.exec();
    return Boolean(current.id);
  }

  async listDrivers(
    filter: DriverListFilter,
    cursor: string | null,
    limit: number,
  ): Promise<Page<DriverRecord>> {
    const key = filter.status ? `${DRIVERS}:s:${filter.status}` : DRIVERS;
    const ids = await this.pageIds(key, cursor, limit);
    const records = await this.loadMany(ids.members, (id) => `bff:rm:driver:${id}`, this.toDriver);
    return { items: records, nextCursor: ids.nextCursor };
  }

  // ── Internos ──

  /** Página de ids por score descendente con cursor exclusivo (cursor = score epoch ms). */
  private async pageIds(
    key: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ members: string[]; nextCursor: string | null }> {
    const max = cursor ? `(${cursor}` : '+inf';
    const raw = await this.redis.zrevrangebyscore(
      key,
      max,
      '-inf',
      'WITHSCORES',
      'LIMIT',
      0,
      limit,
    );
    const members: string[] = [];
    let lastScore: string | null = null;
    for (let i = 0; i < raw.length; i += 2) {
      const member = raw[i];
      if (member === undefined) continue;
      members.push(member);
      lastScore = raw[i + 1] ?? lastScore;
    }
    const nextCursor = members.length === limit ? lastScore : null;
    return { members, nextCursor };
  }

  private async loadMany<T>(
    ids: string[],
    keyOf: (id: string) => string,
    map: (h: Record<string, string>) => T,
  ): Promise<T[]> {
    if (ids.length === 0) return [];
    const pipe = this.redis.multi();
    for (const id of ids) pipe.hgetall(keyOf(id));
    const res = await pipe.exec();
    const out: T[] = [];
    for (const entry of res ?? []) {
      const hash = entry?.[1] as Record<string, string> | undefined;
      if (hash?.id) out.push(map(hash));
    }
    return out;
  }

  private readonly toTrip = (h: Record<string, string>): TripRecord => ({
    id: h.id ?? '',
    status: h.status as TripStatus,
    passengerId: h.passengerId ?? '',
    driverId: typeof h.driverId === 'string' && h.driverId.length > 0 ? h.driverId : null,
    fareCents: Number(h.fareCents ?? 0),
    createdAt: h.createdAt ?? '',
  });

  private readonly toDriver = (h: Record<string, string>): DriverRecord => ({
    id: h.id ?? '',
    userId: h.userId ?? '',
    status: h.status ?? 'UNKNOWN',
    averageRating: h.averageRating ? Number(h.averageRating) : null,
    backgroundCheckStatus: h.backgroundCheckStatus ?? 'PENDING',
    rejectionReason: nonEmptyOrNull(h.rejectionReason),
    updatedAt: h.updatedAt ?? '',
  });
}
