/**
 * S2 (ADR 011 · M5) — el GET /internal/pricing/resolve acepta un `at` (ISO) opcional: resuelve el modo
 * para ESE instante (la hora de recojo del quote de una reserva), o `now` si se omite. Probamos que el
 * controller reenvía el instante correcto al PricingScheduleService.
 */
import { describe, it, expect } from 'vitest';
import { PricingMode } from '@veo/shared-types';
import { PricingController } from './pricing.controller';
import type { PricingScheduleService } from './pricing-schedule.service';
import type { FuelSurchargeService } from './fuel-surcharge.service';
import type { EnergyCatalogService } from './energy-catalog.service';
import type { BidFloorService } from './bid-floor.service';

/** Doble mínimo del EnergyCatalogService (B5): el controller solo lo expone vía GET/PUT energy-catalog. */
function fakeEnergy(): EnergyCatalogService {
  return {
    getCatalog: async () => ({ sources: [], version: 0, updatedAt: new Date(0).toISOString() }),
    getPriceFor: async () => null,
    replace: async () => ({ sources: [], version: 1, updatedAt: new Date(0).toISOString() }),
  } as unknown as EnergyCatalogService;
}

/** Doble del service que CAPTURA el instante con el que se lo invoca y devuelve un modo fijo. */
function fakePricing(mode: PricingMode) {
  const calls: Date[] = [];
  const svc = {
    resolve: async (_zone: 'GLOBAL', at: Date) => {
      calls.push(at);
      return mode;
    },
  } as unknown as PricingScheduleService;
  return { svc, calls };
}

/** Doble del FuelSurchargeService (B4): captura precio+rendimiento reemplazados, devuelve config fija. */
function fakeFuel() {
  const replaced: { price: number; kmPerLiter: number; expectedVersion: number }[] = [];
  const svc = {
    getConfig: async () => ({
      fuelPricePerLiterCents: 420,
      kmPerLiter: 12,
      version: 2,
      updatedAt: '2026-06-16T00:00:00.000Z',
    }),
    replace: async (price: number, kmPerLiter: number, expectedVersion: number) => {
      replaced.push({ price, kmPerLiter, expectedVersion });
      return { fuelPricePerLiterCents: price, kmPerLiter, version: 3, updatedAt: '2026-06-16T00:00:00.000Z' };
    },
  } as unknown as FuelSurchargeService;
  return { svc, replaced };
}

/** Doble del BidFloorService (ADR 010 §9.3): captura el config reemplazado, devuelve config fija. */
function fakeBidFloor() {
  const replaced: { defaultFloorCents: number; overrides: unknown[]; expectedVersion: number }[] = [];
  const svc = {
    getConfig: async () => ({
      defaultFloorCents: 700,
      overrides: [{ zone: 'GLOBAL', offeringId: 'veo_moto', floorCents: 300 }],
      version: 2,
      updatedAt: '2026-06-17T00:00:00.000Z',
    }),
    replace: async (input: { defaultFloorCents: number; overrides: unknown[]; expectedVersion: number }) => {
      replaced.push(input);
      return { defaultFloorCents: input.defaultFloorCents, overrides: input.overrides, version: 3, updatedAt: '2026-06-17T00:00:00.000Z' };
    },
  } as unknown as BidFloorService;
  return { svc, replaced };
}

const LIMA = { lat: -12.0464, lon: -77.0428 };

describe('PricingController.resolve · S2 · `at` opcional', () => {
  it('con `at` → resuelve para ESE instante (hora de recojo)', async () => {
    const { svc, calls } = fakePricing(PricingMode.FIXED);
    const controller = new PricingController(svc, fakeFuel().svc, fakeEnergy(), fakeBidFloor().svc);
    const at = '2026-06-01T22:00:00.000Z';

    const out = await controller.resolve({ ...LIMA, at });

    expect(out).toEqual({ mode: PricingMode.FIXED });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toISOString()).toBe(at);
  });

  it('sin `at` → resuelve para now (default)', async () => {
    const { svc, calls } = fakePricing(PricingMode.PUJA);
    const controller = new PricingController(svc, fakeFuel().svc, fakeEnergy(), fakeBidFloor().svc);
    const before = Date.now();

    const out = await controller.resolve({ ...LIMA });

    expect(out).toEqual({ mode: PricingMode.PUJA });
    expect(calls[0]!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(calls[0]!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('PricingController · fuel surcharge (B4 · precio÷rendimiento)', () => {
  it('GET fuel-surcharge → devuelve la config vigente (precio + rendimiento)', async () => {
    const fuel = fakeFuel();
    const controller = new PricingController(fakePricing(PricingMode.PUJA).svc, fuel.svc, fakeEnergy(), fakeBidFloor().svc);
    expect(await controller.getFuelSurcharge()).toEqual({
      fuelPricePerLiterCents: 420,
      kmPerLiter: 12,
      version: 2,
      updatedAt: '2026-06-16T00:00:00.000Z',
    });
  });

  it('PUT fuel-surcharge → reemplaza con precio + rendimiento del DTO', async () => {
    const fuel = fakeFuel();
    const controller = new PricingController(fakePricing(PricingMode.PUJA).svc, fuel.svc, fakeEnergy(), fakeBidFloor().svc);
    const out = await controller.replaceFuelSurcharge({ fuelPricePerLiterCents: 480, kmPerLiter: 12, expectedVersion: 2 });
    expect(fuel.replaced).toEqual([{ price: 480, kmPerLiter: 12, expectedVersion: 2 }]);
    expect(out.fuelPricePerLiterCents).toBe(480);
    expect(out.kmPerLiter).toBe(12);
  });
});

describe('PricingController · bid floor (ADR 010 §9.3 · per-oferta)', () => {
  it('GET bid-floor → devuelve la config vigente (default + overrides por oferta)', async () => {
    const controller = new PricingController(fakePricing(PricingMode.PUJA).svc, fakeFuel().svc, fakeEnergy(), fakeBidFloor().svc);
    expect(await controller.getBidFloor()).toEqual({
      defaultFloorCents: 700,
      overrides: [{ zone: 'GLOBAL', offeringId: 'veo_moto', floorCents: 300 }],
      version: 2,
      updatedAt: '2026-06-17T00:00:00.000Z',
    });
  });

  it('PUT bid-floor → reemplaza con default + overrides del DTO', async () => {
    const bid = fakeBidFloor();
    const controller = new PricingController(fakePricing(PricingMode.PUJA).svc, fakeFuel().svc, fakeEnergy(), bid.svc);
    const dto = {
      defaultFloorCents: 700,
      overrides: [{ zone: 'GLOBAL' as const, offeringId: 'veo_moto' as const, floorCents: 300 }],
      expectedVersion: 2,
    };
    const out = await controller.replaceBidFloor(dto);
    expect(bid.replaced).toEqual([dto]);
    expect(out.version).toBe(3);
    expect(out.defaultFloorCents).toBe(700);
  });
});
