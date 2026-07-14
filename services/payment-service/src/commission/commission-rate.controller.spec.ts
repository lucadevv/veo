/**
 * Spec de la VISTA MÍNIMA del riel del conductor (CommissionRateController). La regla: el conductor solo
 * conoce la tasa que se le aplica (onDemandRateBps) + version — el resto de la config financiera
 * (carpooling fee, PSP fees, updatedAt) NO debe filtrarse por este endpoint. El scoping de riel
 * (DRIVER_RAIL exclusivo, @Audiences de clase) lo verifica `audience-coverage.spec.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { AUDIENCES_KEY, InternalAudience } from '@veo/auth';
import { CommissionRateController } from './commission-rate.controller';
import type { CommissionService } from './commission.service';
import type { PersistedCommission } from './commission.repository';

const fullConfig: PersistedCommission = {
  onDemandRateBps: 2000,
  carpoolingFeeBps: 700,
  version: 5,
  carpoolingFeeVersion: 3,
  yapeFeeBps: 150,
  plinFeeBps: 150,
  cardFeeBps: 350,
  pagoefectivoFeeBps: 200,
  updatedAt: '2026-07-01T00:00:00.000Z',
};

function makeController(config: PersistedCommission = fullConfig) {
  const commission = { getConfig: vi.fn(() => Promise.resolve(config)) };
  return new CommissionRateController(commission as unknown as CommissionService);
}

describe('CommissionRateController.getOnDemandRate', () => {
  it('devuelve la tasa on-demand vigente + version', async () => {
    const view = await makeController().getOnDemandRate();
    expect(view.onDemandRateBps).toBe(2000);
    expect(view.version).toBe(5);
  });

  it('proyecta SOLO {onDemandRateBps, version} — nada de carpooling/PSP/updatedAt se filtra al conductor', async () => {
    const view = await makeController().getOnDemandRate();
    expect(Object.keys(view).sort()).toEqual(['onDemandRateBps', 'version']);
  });

  it('scopea el riel del conductor en exclusiva (DRIVER_RAIL, a nivel de clase)', () => {
    const audiences = Reflect.getMetadata(AUDIENCES_KEY, CommissionRateController) as
      | InternalAudience[]
      | undefined;
    expect(audiences).toEqual([InternalAudience.DRIVER_RAIL]);
  });
});
