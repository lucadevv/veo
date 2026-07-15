/**
 * RadarPreviewService — densidad REAL de conductores por anillo. Reutiliza el hot-index (candidates);
 * el conteo por anillo es el tamaño del disco H3. Los discos gridDisk acumulan → conteo monotónico.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { toH3, neighbors, DISPATCH_H3_RESOLUTION, type LatLon } from '@veo/utils';
import { VehicleType } from '@veo/shared-types';
import { RadarPreviewService } from './radar-preview.service';
import { InMemoryHotIndex } from '../hot-index/in-memory-hot-index';
import type { DispatchRadiusConfigService } from './dispatch-radius-config.service';
import type { DispatchPolicyV2 } from './dispatch-policy';

const CENTER: LatLon = { lat: -12.0464, lon: -77.0428 };
const OUTSIDE_LIMA: LatLon = { lat: 40.0, lon: -3.0 };

const V2: DispatchPolicyV2 = {
  FIXED: {
    initialRadiusKm: 0.3, // k1
    incrementKm: 0.3, // → 0.6(k2) 0.9(k3) 1.2(k4) 1.5(k5)
    maxRadiusKm: 1.5,
    targetDrivers: 3,
    offerTimeoutSec: 20,
    expandIntervalSec: 8,
  },
  PUJA: { broadcastRadiusKm: 1.2, bidWindowSec: 60 }, // k4
};

function cellsAtRing(center: string, ring: number): string[] {
  const inner = new Set(neighbors(center, ring - 1));
  return neighbors(center, ring).filter((c) => !inner.has(c));
}

function makeSvc(policyVersion: 'v1' | 'v2', v2: DispatchPolicyV2 | null) {
  const hotIndex = new InMemoryHotIndex();
  const radiusConfig = {
    getPolicy: async () => ({ policyVersion, v2 }),
    getKRings: async () => ({ nearbyKRing: 3, matchKRing: 4 }),
  } as unknown as DispatchRadiusConfigService;
  return { svc: new RadarPreviewService(hotIndex, radiusConfig), hotIndex };
}

describe('RadarPreviewService', () => {
  const center = toH3(CENTER, DISPATCH_H3_RESOLUTION);
  let ctx: ReturnType<typeof makeSvc>;

  describe('FIXED v2 — pasos km initial→increment→max', () => {
    beforeEach(async () => {
      ctx = makeSvc('v2', V2);
      // 1 en el centro (en todos los discos) + 1 en el anillo 3 (solo k≥3).
      await ctx.hotIndex.seed('d-center', CENTER.lat, CENTER.lon, center, VehicleType.CAR);
      await ctx.hotIndex.seed('d-r3', CENTER.lat, CENTER.lon, cellsAtRing(center, 3)[0]!, VehicleType.CAR);
    });

    it('devuelve un anillo por k distinto con la cuenta REAL acumulada + totalInRange', async () => {
      const res = await ctx.svc.preview('FIXED', CENTER);
      expect(res.mode).toBe('FIXED');
      expect(res.rings.map((r) => r.kRing)).toEqual([1, 2, 3, 4, 5]);
      expect(res.rings.map((r) => r.radiusKm)).toEqual([0.3, 0.6, 0.9, 1.2, 1.5]);
      // center visible en todos; d-r3 entra recién en k3 → 1,1,2,2,2.
      expect(res.rings.map((r) => r.driverCount)).toEqual([1, 1, 2, 2, 2]);
      expect(res.totalInRange).toBe(2); // conteo del anillo más ancho
    });

    it('devuelve la MUESTRA de posiciones (lat/lon) del anillo más ancho, sin PII', async () => {
      const res = await ctx.svc.preview('FIXED', CENTER);
      // Anillo más ancho (k5) = ambos conductores → 2 posiciones (solo lat/lon, sin driverId/vehicleType).
      expect(res.drivers).toHaveLength(2);
      expect(res.drivers).toContainEqual({ lat: CENTER.lat, lon: CENTER.lon });
      expect(res.drivers.every((d) => Object.keys(d).sort().join(',') === 'lat,lon')).toBe(true);
    });

    it('honesto 0 cuando no hay conductores', async () => {
      const empty = makeSvc('v2', V2);
      const res = await empty.svc.preview('FIXED', CENTER);
      expect(res.rings.every((r) => r.driverCount === 0)).toBe(true);
      expect(res.totalInRange).toBe(0);
      expect(res.drivers).toEqual([]);
    });

    it('CAPA la muestra a 100 posiciones aunque el anillo tenga más conductores', async () => {
      const dense = makeSvc('v2', V2);
      // 150 conductores en el centro (todos caen en el disco más ancho) → la muestra se capa a 100.
      for (let i = 0; i < 150; i++) {
        await dense.hotIndex.seed(`d-${i}`, CENTER.lat, CENTER.lon, center, VehicleType.CAR);
      }
      const res = await dense.svc.preview('FIXED', CENTER);
      expect(res.rings[res.rings.length - 1]!.driverCount).toBe(150); // el conteo NO se capa
      expect(res.drivers).toHaveLength(100); // la muestra SÍ
    });
  });

  it('PUJA v2 — un único anillo al radio de broadcast (k4)', async () => {
    ctx = makeSvc('v2', V2);
    await ctx.hotIndex.seed('d-center', CENTER.lat, CENTER.lon, center, VehicleType.CAR);
    await ctx.hotIndex.seed('d-r3', CENTER.lat, CENTER.lon, cellsAtRing(center, 3)[0]!, VehicleType.CAR);
    const res = await ctx.svc.preview('PUJA', CENTER);
    expect(res.rings).toHaveLength(1);
    expect(res.rings[0]).toMatchObject({ radiusKm: 1.2, kRing: 4, driverCount: 2 });
    expect(res.totalInRange).toBe(2);
  });

  it('v1 (sin policyV2) — un único anillo al matchKRing vigente', async () => {
    ctx = makeSvc('v1', null);
    await ctx.hotIndex.seed('d-center', CENTER.lat, CENTER.lon, center, VehicleType.CAR);
    const res = await ctx.svc.preview('FIXED', CENTER);
    expect(res.rings).toHaveLength(1);
    expect(res.rings[0]!.kRing).toBe(4); // matchKRing del fake
    expect(res.rings[0]!.driverCount).toBe(1);
  });

  it('centro fuera de Lima → 0 anillos honestos (no consulta el índice)', async () => {
    ctx = makeSvc('v2', V2);
    const res = await ctx.svc.preview('FIXED', OUTSIDE_LIMA);
    expect(res.rings).toEqual([]);
    expect(res.totalInRange).toBe(0);
    expect(res.drivers).toEqual([]);
  });
});
