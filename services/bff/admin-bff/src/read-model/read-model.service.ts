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

/** Normaliza un valor de hash Redis (ausente o "") a null; cualquier string no vacío se preserva. */
function nonEmptyOrNull(value: string | undefined): string | null {
  return value !== undefined && value !== '' ? value : null;
}

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

  async listTrips(filter: TripListFilter, cursor: string | null, limit: number): Promise<Page<TripRecord>> {
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

  async upsertDriver(rec: Partial<DriverRecord> & { id: string }): Promise<void> {
    const keyHash = `bff:rm:driver:${rec.id}`;
    const current = await this.redis.hgetall(keyHash);
    const merged: DriverRecord = {
      id: rec.id,
      userId: rec.userId ?? current.userId ?? '',
      status: rec.status ?? current.status ?? 'UNKNOWN',
      averageRating:
        rec.averageRating !== undefined
          ? rec.averageRating
          : current.averageRating
            ? Number(current.averageRating)
            : null,
      backgroundCheckStatus: rec.backgroundCheckStatus ?? current.backgroundCheckStatus ?? 'PENDING',
      // null SOLO si se pasó explícito (re-aprobación limpia el motivo); undefined conserva el actual.
      // El hash de Redis guarda "" para "sin motivo": nonEmptyOrNull lo normaliza (cadena vacía → null).
      rejectionReason:
        rec.rejectionReason !== undefined
          ? rec.rejectionReason
          : nonEmptyOrNull(current.rejectionReason),
      updatedAt: rec.updatedAt ?? new Date().toISOString(),
    };
    const score = Date.parse(merged.updatedAt) || Date.now();
    const prevStatus = current.status;
    const pipe = this.redis.multi();
    pipe.hset(keyHash, {
      id: merged.id,
      userId: merged.userId,
      status: merged.status,
      averageRating: merged.averageRating === null ? '' : String(merged.averageRating),
      backgroundCheckStatus: merged.backgroundCheckStatus,
      rejectionReason: merged.rejectionReason ?? '',
      updatedAt: merged.updatedAt,
    });
    pipe.expire(keyHash, TTL_SECONDS);
    pipe.zadd(DRIVERS, score, merged.id);
    pipe.zadd(`${DRIVERS}:s:${merged.status}`, score, merged.id);
    if (prevStatus && prevStatus !== merged.status) pipe.zrem(`${DRIVERS}:s:${prevStatus}`, merged.id);
    await pipe.exec();
  }

  async listDrivers(filter: DriverListFilter, cursor: string | null, limit: number): Promise<Page<DriverRecord>> {
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
    const raw = await this.redis.zrevrangebyscore(key, max, '-inf', 'WITHSCORES', 'LIMIT', 0, limit);
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
