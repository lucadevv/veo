/**
 * S2 (ADR 011 · M5) — el GET /internal/pricing/resolve acepta un `at` (ISO) opcional: resuelve el modo
 * para ESE instante (la hora de recojo del quote de una reserva), o `now` si se omite. Probamos que el
 * controller reenvía el instante correcto al PricingScheduleService.
 */
import { describe, it, expect } from 'vitest';
import { PricingMode } from '@veo/shared-types';
import { PricingController } from './pricing.controller';
import type { PricingScheduleService } from './pricing-schedule.service';
import type { ResolveQueryDto } from './dto/resolve-query.dto';

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

const LIMA = { lat: -12.0464, lon: -77.0428 };

describe('PricingController.resolve · S2 · `at` opcional', () => {
  it('con `at` → resuelve para ESE instante (hora de recojo)', async () => {
    const { svc, calls } = fakePricing(PricingMode.FIXED);
    const controller = new PricingController(svc);
    const at = '2026-06-01T22:00:00.000Z';

    const out = await controller.resolve({ ...LIMA, at } as ResolveQueryDto);

    expect(out).toEqual({ mode: PricingMode.FIXED });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toISOString()).toBe(at);
  });

  it('sin `at` → resuelve para now (default)', async () => {
    const { svc, calls } = fakePricing(PricingMode.PUJA);
    const controller = new PricingController(svc);
    const before = Date.now();

    const out = await controller.resolve({ ...LIMA } as ResolveQueryDto);

    expect(out).toEqual({ mode: PricingMode.PUJA });
    expect(calls[0]!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(calls[0]!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
