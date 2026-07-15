/**
 * PricingController (ADR 023) — endpoints internos de config de pricing editable en caliente. El schedule
 * de modo (ADR 011) se retiró: el modo vive POR OFERTA en el catálogo. Acá quedan la tarifa base global
 * (F2.4) y el piso de la puja (ADR 010 §9.3). Probamos el cableado GET/PUT contra dobles de los servicios.
 */
import { describe, it, expect } from 'vitest';
import { PricingController } from './pricing.controller';
import type { BidFloorService } from './bid-floor.service';
import type { BaseFareService } from './base-fare.service';

/** Doble del BidFloorService (ADR 010 §9.3): captura el config reemplazado, devuelve config fija. */
function fakeBidFloor() {
  const replaced: { defaultFloorCents: number; overrides: unknown[]; expectedVersion: number }[] =
    [];
  const svc = {
    getConfig: async () => ({
      defaultFloorCents: 700,
      overrides: [{ offeringId: 'veo_moto', floorCents: 300 }],
      version: 2,
      updatedAt: '2026-06-17T00:00:00.000Z',
    }),
    replace: async (input: {
      defaultFloorCents: number;
      overrides: unknown[];
      expectedVersion: number;
    }) => {
      replaced.push(input);
      return {
        defaultFloorCents: input.defaultFloorCents,
        overrides: input.overrides,
        version: 3,
        updatedAt: '2026-06-17T00:00:00.000Z',
      };
    },
  } as unknown as BidFloorService;
  return { svc, replaced };
}

/** Doble del BaseFareService (F2.4): captura los componentes reemplazados, devuelve config fija. */
function fakeBaseFare() {
  const replaced: {
    baseFareCents: number;
    perKmCents: number;
    perMinCents: number;
    expectedVersion: number;
  }[] = [];
  const svc = {
    getConfig: async () => ({
      baseFareCents: 600,
      perKmCents: 120,
      perMinCents: 30,
      version: 1,
      updatedAt: '2026-06-27T00:00:00.000Z',
    }),
    replace: async (
      baseFareCents: number,
      perKmCents: number,
      perMinCents: number,
      expectedVersion: number,
    ) => {
      replaced.push({ baseFareCents, perKmCents, perMinCents, expectedVersion });
      return {
        baseFareCents,
        perKmCents,
        perMinCents,
        version: 2,
        updatedAt: '2026-06-27T00:00:00.000Z',
      };
    },
  } as unknown as BaseFareService;
  return { svc, replaced };
}

describe('PricingController · bid floor (ADR 010 §9.3 · per-oferta)', () => {
  it('GET bid-floor → devuelve la config vigente (default + overrides por oferta)', async () => {
    const controller = new PricingController(fakeBidFloor().svc, fakeBaseFare().svc);
    expect(await controller.getBidFloor()).toEqual({
      defaultFloorCents: 700,
      overrides: [{ offeringId: 'veo_moto', floorCents: 300 }],
      version: 2,
      updatedAt: '2026-06-17T00:00:00.000Z',
    });
  });

  it('PUT bid-floor → reemplaza con default + overrides del DTO', async () => {
    const bid = fakeBidFloor();
    const controller = new PricingController(bid.svc, fakeBaseFare().svc);
    const dto = {
      defaultFloorCents: 700,
      overrides: [{ offeringId: 'veo_moto' as const, floorCents: 300 }],
      expectedVersion: 2,
    };
    const out = await controller.replaceBidFloor(dto);
    expect(bid.replaced).toEqual([dto]);
    expect(out.version).toBe(3);
    expect(out.defaultFloorCents).toBe(700);
  });
});

describe('PricingController · base fare (F2.4)', () => {
  it('GET base-fare → devuelve el triple vigente + version', async () => {
    const controller = new PricingController(fakeBidFloor().svc, fakeBaseFare().svc);
    expect(await controller.getBaseFare()).toEqual({
      baseFareCents: 600,
      perKmCents: 120,
      perMinCents: 30,
      version: 1,
      updatedAt: '2026-06-27T00:00:00.000Z',
    });
  });

  it('PUT base-fare → reemplaza el banderazo/km/min del DTO (CAS por expectedVersion)', async () => {
    const base = fakeBaseFare();
    const controller = new PricingController(fakeBidFloor().svc, base.svc);
    const dto = { baseFareCents: 700, perKmCents: 130, perMinCents: 40, expectedVersion: 1 };
    const out = await controller.replaceBaseFare(dto);
    expect(base.replaced).toEqual([dto]);
    expect(out.version).toBe(2);
    expect(out.baseFareCents).toBe(700);
  });
});
