import { describe, it, expect } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { toH3, neighbors, DISPATCH_H3_RESOLUTION } from '@veo/utils';
import { SurgeService } from './surge.service';
import { InMemoryHotIndex } from '../hot-index/in-memory-hot-index';
import type { Env } from '../config/env.schema';

const POINT = { lat: -12.0464, lon: -77.0428 };
const CELL = toH3(POINT, DISPATCH_H3_RESOLUTION);
const ZONE_CELLS = neighbors(CELL, 1);

interface ZoneSeed {
  id: string;
  name: string;
  cells: string[];
  minLat: number | null;
  maxLat: number | null;
  minLon: number | null;
  maxLon: number | null;
  demandSupplyThreshold: number;
  multiplier: number;
}

function makeService(opts: { zones: ZoneSeed[]; demand: string | null }) {
  const hotIndex = new InMemoryHotIndex();
  const prisma = { read: { surgeZone: { findMany: async () => opts.zones } } };
  const redis = {
    get: async () => opts.demand,
    incr: async () => 1,
    expire: async () => 1,
  };
  const config = new ConfigService<Env, true>({
    SURGE_DEMAND_WINDOW_SECONDS: 300,
  } as Partial<Env> as Env);
  const service = new SurgeService(prisma as never, redis, hotIndex, config);
  return { service, hotIndex };
}

const zone: ZoneSeed = {
  id: 'zone-1',
  name: 'Centro',
  cells: ZONE_CELLS,
  minLat: null,
  maxLat: null,
  minLon: null,
  maxLon: null,
  demandSupplyThreshold: 1.5,
  multiplier: 1.5,
};

describe('SurgeService · pricing dinámico (BR-T06)', () => {
  it('aplica el multiplier cuando demanda/oferta supera el umbral', async () => {
    const { service, hotIndex } = makeService({ zones: [zone], demand: '10' });
    await hotIndex.seed('d1', POINT.lat, POINT.lon, CELL);
    await hotIndex.seed('d2', POINT.lat, POINT.lon, CELL); // supply = 2 → ratio 10/2 = 5 > 1.5

    const quote = await service.quote(POINT);

    expect(quote.active).toBe(true);
    expect(quote.multiplier).toBe(1.5);
    expect(quote.zoneId).toBe('zone-1');
  });

  it('no aplica recargo cuando la oferta cubre la demanda', async () => {
    const { service, hotIndex } = makeService({ zones: [zone], demand: '2' });
    await hotIndex.seed('d1', POINT.lat, POINT.lon, CELL);
    await hotIndex.seed('d2', POINT.lat, POINT.lon, CELL); // ratio 2/2 = 1 <= 1.5

    const quote = await service.quote(POINT);

    expect(quote.active).toBe(false);
    expect(quote.multiplier).toBe(1.0);
  });

  it('devuelve 1.0 cuando el origen no cae en ninguna zona', async () => {
    const { service } = makeService({ zones: [], demand: '99' });

    const quote = await service.quote(POINT);

    expect(quote.multiplier).toBe(1.0);
    expect(quote.zoneId).toBeNull();
    expect(quote.active).toBe(false);
  });

  it('escasez de conductores (supply 0, demanda > 0) dispara surge', async () => {
    const { service } = makeService({ zones: [zone], demand: '3' }); // sin drivers → supply 0

    const quote = await service.quote(POINT);

    expect(quote.active).toBe(true);
    expect(quote.multiplier).toBe(1.5);
  });
});
