/**
 * HeatmapService — mapa de calor de demanda por celda H3 (Ola 2C).
 *
 * Vive en dispatch-service porque éste YA consume `trip.requested`, posee la lógica H3 (res 9) y el
 * Redis del hot index; agregar aquí la intensidad evita un servicio extra y un join cross-dominio.
 *
 * Modelo (Redis, soberano):
 *  - `heatmap:cell:{h3}` = contador de solicitudes recientes en esa celda, con TTL DESLIZANTE
 *    (`HEATMAP_WINDOW_SECONDS`): cada nueva solicitud refresca el TTL, así una celda "se enfría"
 *    sola si deja de pedirse. No hace falta barrido ni SCAN.
 *
 * Lectura (`heatmap`): a partir del punto del conductor se expande un k-ring H3 (derivado del radio
 * pedido) y se leen los contadores de esas celdas con un único MGET. La intensidad se normaliza 0..1
 * dividiendo por el máximo del entorno (1 = la celda más caliente cerca del conductor).
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import {
  toH3,
  fromH3,
  neighbors,
  DISPATCH_H3_RESOLUTION,
  distanceMeters,
  type LatLon,
} from '@veo/utils';
import { REDIS } from '../infra/redis';
import type { Env } from '../config/env.schema';

const CELL_PREFIX = 'heatmap:cell:';
/** Radio H3 por defecto si el conductor no envía uno (metros). */
const DEFAULT_RADIUS_METERS = 2500;
/** Tope de anillos H3 para acotar el coste de lectura (k=6 ≈ ~127 celdas, ~2 km a res 9). */
const MAX_K_RING = 6;
/** Arista aproximada de una celda H3 res 9 en metros (para derivar el k-ring del radio). */
const H3_RES9_EDGE_METERS = 174;

export interface HeatmapCellView {
  h3: string;
  centroidLat: number;
  centroidLng: number;
  intensity: number;
}

export interface HeatmapView {
  cells: HeatmapCellView[];
  generatedAt: string;
}

@Injectable()
export class HeatmapService {
  private readonly windowSeconds: number;

  constructor(
    @Inject(REDIS) private readonly redis: Pick<Redis, 'incr' | 'expire' | 'mget'>,
    config: ConfigService<Env, true>,
  ) {
    this.windowSeconds = config.getOrThrow<number>('HEATMAP_WINDOW_SECONDS');
  }

  private cellKey(h3: string): string {
    return `${CELL_PREFIX}${h3}`;
  }

  /**
   * Registra una unidad de demanda en la celda del punto (llamado al consumir `trip.requested`).
   * Incrementa el contador y refresca el TTL → ventana deslizante.
   */
  async recordDemand(point: LatLon): Promise<void> {
    const cell = toH3(point, DISPATCH_H3_RESOLUTION);
    const key = this.cellKey(cell);
    await this.redis.incr(key);
    // Refresca el TTL en cada solicitud: la celda permanece "caliente" mientras se pida.
    await this.redis.expire(key, this.windowSeconds);
  }

  /**
   * Devuelve las celdas con demanda reciente alrededor del punto, con intensidad normalizada 0..1.
   * `radiusMeters` se traduce a un k-ring H3 (acotado por MAX_K_RING). Las celdas sin demanda se
   * omiten. Orden: intensidad descendente.
   */
  async heatmap(point: LatLon, radiusMeters?: number): Promise<HeatmapView> {
    const radius = radiusMeters && radiusMeters > 0 ? radiusMeters : DEFAULT_RADIUS_METERS;
    const k = Math.min(MAX_K_RING, Math.max(1, Math.round(radius / H3_RES9_EDGE_METERS)));
    const center = toH3(point, DISPATCH_H3_RESOLUTION);
    const cells = neighbors(center, k);

    const counts = await this.redis.mget(...cells.map((c) => this.cellKey(c)));
    const raw: { h3: string; count: number; centroid: LatLon }[] = [];
    let max = 0;
    cells.forEach((cell, i) => {
      const count = Number(counts[i] ?? 0);
      if (count <= 0) return;
      const centroid = fromH3(cell);
      // Filtra duro por el radio real pedido (el k-ring es hexagonal, no circular).
      if (distanceMeters(point, centroid) > radius) return;
      raw.push({ h3: cell, count, centroid });
      if (count > max) max = count;
    });

    const result: HeatmapCellView[] = raw
      .map((c) => ({
        h3: c.h3,
        centroidLat: c.centroid.lat,
        centroidLng: c.centroid.lon,
        intensity: max > 0 ? c.count / max : 0,
      }))
      .sort((a, b) => b.intensity - a.intensity);

    return { cells: result, generatedAt: new Date().toISOString() };
  }
}
