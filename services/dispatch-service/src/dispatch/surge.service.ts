/**
 * SurgeService — pricing dinámico por zona (BR-T06).
 * Si el origen cae en una `surge_zone` activa Y la demanda/oferta supera el umbral de la zona,
 * devuelve el multiplier configurado (1.2–2.0). En otro caso, 1.0 (sin recargo).
 *
 * - Oferta (supply): conductores disponibles en las celdas de la zona (hot index, baja latencia).
 * - Demanda (demand): nº de `trip.requested` recientes en la zona (contador Redis con TTL).
 * El multiplier se devuelve para que trip-service lo use al calcular la tarifa (no lo aplica dispatch).
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { toH3, DISPATCH_H3_RESOLUTION, type LatLon } from '@veo/utils';
import { REDIS } from '../infra/redis';
import { HOT_INDEX, type HotIndex } from '../hot-index/hot-index.port';
import { SURGE_REPO, type SurgeRepository } from './surge.repository';
import type { Env } from '../config/env.schema';

const DEMAND_PREFIX = 'surge:demand:';
const MIN_MULTIPLIER = 1.0;
const MAX_MULTIPLIER = 2.0;

export interface SurgeQuote {
  multiplier: number;
  zoneId: string | null;
  zoneName: string | null;
  active: boolean;
  demand: number;
  supply: number;
  ratio: number;
}

interface ZoneRow {
  id: string;
  name: string;
  cells: unknown;
  minLat: number | null;
  maxLat: number | null;
  minLon: number | null;
  maxLon: number | null;
  demandSupplyThreshold: { toString(): string };
  multiplier: { toString(): string };
}

@Injectable()
export class SurgeService {
  private readonly demandWindow: number;

  constructor(
    @Inject(SURGE_REPO) private readonly repo: SurgeRepository,
    @Inject(REDIS) private readonly redis: Pick<Redis, 'get' | 'incr' | 'expire'>,
    @Inject(HOT_INDEX) private readonly hotIndex: HotIndex,
    config: ConfigService<Env, true>,
  ) {
    this.demandWindow = config.getOrThrow<number>('SURGE_DEMAND_WINDOW_SECONDS');
  }

  private static zoneCells(zone: ZoneRow): string[] {
    return Array.isArray(zone.cells) ? (zone.cells as string[]) : [];
  }

  private static contains(zone: ZoneRow, point: LatLon, cell: string): boolean {
    const cells = SurgeService.zoneCells(zone);
    if (cells.length > 0) return cells.includes(cell);
    if (zone.minLat != null && zone.maxLat != null && zone.minLon != null && zone.maxLon != null) {
      return (
        point.lat >= zone.minLat &&
        point.lat <= zone.maxLat &&
        point.lon >= zone.minLon &&
        point.lon <= zone.maxLon
      );
    }
    return false;
  }

  private async findActiveZone(point: LatLon, cell: string): Promise<ZoneRow | null> {
    const zones = (await this.repo.findActiveZones()) as ZoneRow[];
    return zones.find((z) => SurgeService.contains(z, point, cell)) ?? null;
  }

  /** Registra una unidad de demanda en la zona del punto (llamado al consumir trip.requested). */
  async recordDemand(point: LatLon): Promise<void> {
    const cell = toH3(point, DISPATCH_H3_RESOLUTION);
    const zone = await this.findActiveZone(point, cell);
    if (!zone) return;
    const key = `${DEMAND_PREFIX}${zone.id}`;
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, this.demandWindow);
  }

  /** Cotiza el multiplier de surge para un punto. Devuelve 1.0 si no hay zona/recargo. */
  async quote(point: LatLon): Promise<SurgeQuote> {
    const cell = toH3(point, DISPATCH_H3_RESOLUTION);
    const zone = await this.findActiveZone(point, cell);
    if (!zone) {
      return {
        multiplier: MIN_MULTIPLIER,
        zoneId: null,
        zoneName: null,
        active: false,
        demand: 0,
        supply: 0,
        ratio: 0,
      };
    }

    const demand = Number((await this.redis.get(`${DEMAND_PREFIX}${zone.id}`)) ?? 0);
    const cells = SurgeService.zoneCells(zone);
    const supply = cells.length > 0 ? (await this.hotIndex.candidates(cells)).length : 0;
    const threshold = Number(zone.demandSupplyThreshold.toString());
    const ratio = supply > 0 ? demand / supply : demand > 0 ? Number.POSITIVE_INFINITY : 0;

    const surged = ratio > threshold;
    const configured = Number(zone.multiplier.toString());
    const multiplier = surged
      ? Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, configured))
      : MIN_MULTIPLIER;

    return {
      multiplier,
      zoneId: zone.id,
      zoneName: zone.name,
      active: surged,
      demand,
      supply,
      ratio: Number.isFinite(ratio) ? ratio : demand,
    };
  }
}
