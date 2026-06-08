import { describe, it, expect } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { toH3, fromH3, DISPATCH_H3_RESOLUTION } from '@veo/utils';
import { HeatmapService } from './heatmap.service';
import type { Env } from '../config/env.schema';

const POINT = { lat: -12.0464, lon: -77.0428 };

/** Redis mínimo en memoria: incr/expire/mget sobre un Map de contadores. */
function makeRedis() {
  const store = new Map<string, number>();
  const expires: string[] = [];
  return {
    store,
    expires,
    redis: {
      incr: async (key: string) => {
        const next = (store.get(key) ?? 0) + 1;
        store.set(key, next);
        return next;
      },
      expire: async (key: string) => {
        expires.push(key);
        return 1;
      },
      mget: async (...keys: string[]) => keys.map((k) => (store.has(k) ? String(store.get(k)) : null)),
    },
  };
}

function makeService() {
  const { redis, store, expires } = makeRedis();
  const config = new ConfigService<Env, true>({ HEATMAP_WINDOW_SECONDS: 900 } as Partial<Env> as Env);
  const service = new HeatmapService(redis as never, config);
  return { service, store, expires };
}

describe('HeatmapService', () => {
  it('recordDemand incrementa la celda del punto y refresca su TTL (ventana deslizante)', async () => {
    const { service, store, expires } = makeService();
    await service.recordDemand(POINT);
    await service.recordDemand(POINT);
    const cellKey = `heatmap:cell:${toH3(POINT, DISPATCH_H3_RESOLUTION)}`;
    expect(store.get(cellKey)).toBe(2);
    // El TTL se refresca en cada solicitud (dos expires).
    expect(expires.filter((k) => k === cellKey)).toHaveLength(2);
  });

  it('heatmap normaliza la intensidad 0..1 y la celda más caliente vale 1', async () => {
    const { service } = makeService();
    // Celda del punto: 3 solicitudes.
    await service.recordDemand(POINT);
    await service.recordDemand(POINT);
    await service.recordDemand(POINT);
    // Una celda vecina cercana (centro de una celda adyacente): 1 solicitud.
    const center = toH3(POINT, DISPATCH_H3_RESOLUTION);
    const neighborCentroid = fromH3(center); // mismo punto → misma celda; usamos un punto desplazado
    await service.recordDemand({ lat: neighborCentroid.lat + 0.002, lon: neighborCentroid.lon + 0.002 });

    const view = await service.heatmap(POINT, 3000);
    expect(view.cells.length).toBeGreaterThanOrEqual(1);
    // La más caliente es la del punto (3 solicitudes) con intensidad 1.
    expect(view.cells[0]?.intensity).toBe(1);
    // Orden descendente por intensidad.
    for (let i = 1; i < view.cells.length; i++) {
      expect(view.cells[i - 1]!.intensity).toBeGreaterThanOrEqual(view.cells[i]!.intensity);
    }
    expect(view.generatedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('heatmap devuelve [] cuando no hay demanda en el entorno', async () => {
    const { service } = makeService();
    const view = await service.heatmap(POINT, 2000);
    expect(view.cells).toEqual([]);
  });
});
