/**
 * DispatchConfigService (admin-bff) — proxy de la config de RADIOS (k-rings + política v2) hacia dispatch-service
 * y del radio de búsqueda del CARPOOLING hacia booking-service. Guardrails:
 *  (1) replaceRadiusConfig propaga policyVersion/policyV2 al PUT interno + los audita;
 *  (2) radarPreview NORMALIZA driverCount→count (contrato uniforme hacia el admin);
 *  (3) carpool get/put/radar viajan por REST_BOOKING (no por REST_DISPATCH) + el PUT audita.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  dispatchRadiusConfigView,
  carpoolSearchConfigView,
  radarPreview,
  type DispatchPolicyV2,
} from '@veo/api-client';
import { DispatchConfigService } from './dispatch-config.service';

const operator = { userId: 'op-1', type: 'admin', roles: ['DISPATCHER'] } as never;

function policyV2(): DispatchPolicyV2 {
  return {
    FIXED: {
      initialRadiusKm: 0.5,
      incrementKm: 0.3,
      maxRadiusKm: 2.0,
      targetDrivers: 5,
      offerTimeoutSec: 12,
      expandIntervalSec: 8,
    },
    PUJA: { broadcastRadiusKm: 1.5, bidWindowSec: 60 },
  };
}

function radiusConfigRow(over: Record<string, unknown> = {}) {
  return {
    nearbyKRing: 3,
    matchKRing: 4,
    offerTimeoutMs: 12_000,
    bidWindowSec: 60,
    policyVersion: 'v2' as const,
    policyV2: policyV2(),
    version: 7,
    updatedAt: '2026-06-20T12:00:00.000Z',
    ...over,
  };
}

function make() {
  const rest = { get: vi.fn(), put: vi.fn() };
  const bookingRest = { get: vi.fn(), put: vi.fn() };
  const audit = { record: vi.fn().mockResolvedValue({ id: 'a1', seq: '1', hash: 'h' }) };
  const svc = new DispatchConfigService(rest as never, bookingRest as never, audit as never);
  return { svc, rest, bookingRest, audit };
}

describe('DispatchConfigService.replaceRadiusConfig · v2 passthrough + audit', () => {
  it('propaga policyVersion + policyV2 al PUT interno de dispatch-service', async () => {
    const { svc, rest } = make();
    rest.put.mockResolvedValue(radiusConfigRow());
    const dto = {
      nearbyKRing: 3,
      matchKRing: 4,
      offerTimeoutMs: 12_000,
      bidWindowSec: 60,
      policyVersion: 'v2' as const,
      policyV2: policyV2(),
    };
    await svc.replaceRadiusConfig(operator, dto as never);
    expect(rest.put).toHaveBeenCalledWith(
      '/internal/dispatch/radius-config',
      expect.objectContaining({
        identity: operator,
        body: expect.objectContaining({ policyVersion: 'v2', policyV2: policyV2() }),
      }),
    );
  });

  it('back-compat: sin v2 en el DTO, el body NO lleva policyVersion/policyV2', async () => {
    const { svc, rest } = make();
    rest.put.mockResolvedValue(radiusConfigRow({ policyVersion: 'v1', policyV2: null }));
    await svc.replaceRadiusConfig(operator, {
      nearbyKRing: 3,
      matchKRing: 4,
      offerTimeoutMs: 12_000,
      bidWindowSec: 60,
    } as never);
    const body = rest.put.mock.calls[0]![1].body;
    expect(body).not.toHaveProperty('policyVersion');
    expect(body).not.toHaveProperty('policyV2');
  });

  it('audita la mutación con policyVersion + policyV2 en el payload', async () => {
    const { svc, rest, audit } = make();
    rest.put.mockResolvedValue(radiusConfigRow());
    await svc.replaceRadiusConfig(operator, {
      nearbyKRing: 3,
      matchKRing: 4,
      offerTimeoutMs: 12_000,
      bidWindowSec: 60,
      policyVersion: 'v2',
      policyV2: policyV2(),
    } as never);
    expect(audit.record).toHaveBeenCalledWith(
      operator,
      expect.objectContaining({
        action: 'dispatch.radius_config_replace',
        resourceType: 'dispatch_radius_config',
        resourceId: '7',
        payload: expect.objectContaining({ policyVersion: 'v2', policyV2: policyV2() }),
      }),
    );
  });

  it('el resultado satisface el contrato Zod dispatchRadiusConfigView v2 (parse no lanza)', async () => {
    const { svc, rest } = make();
    rest.put.mockResolvedValue(radiusConfigRow());
    const view = await svc.replaceRadiusConfig(operator, {
      nearbyKRing: 3,
      matchKRing: 4,
      offerTimeoutMs: 12_000,
      bidWindowSec: 60,
      policyVersion: 'v2',
      policyV2: policyV2(),
    } as never);
    expect(() => dispatchRadiusConfigView.parse(view)).not.toThrow();
  });
});

describe('DispatchConfigService.radarPreview · normalización driverCount→count', () => {
  it('llama el radar interno con mode/lat/lon y NORMALIZA driverCount→count', async () => {
    const { svc, rest } = make();
    const positions = [
      { lat: -12.05, lon: -77.04 },
      { lat: -12.06, lon: -77.05 },
    ];
    rest.get.mockResolvedValue({
      mode: 'FIXED',
      center: { lat: -12.05, lon: -77.04 },
      rings: [
        { radiusKm: 0.5, kRing: 1, driverCount: 3 },
        { radiusKm: 1.0, kRing: 2, driverCount: 5 },
      ],
      totalInRange: 8,
      drivers: positions,
    });
    const view = await svc.radarPreview(operator, 'FIXED', -12.05, -77.04);
    expect(rest.get).toHaveBeenCalledWith(
      '/internal/dispatch/radar-preview',
      expect.objectContaining({ query: { mode: 'FIXED', lat: -12.05, lon: -77.04 } }),
    );
    expect(view.rings).toEqual([
      { radiusKm: 0.5, kRing: 1, count: 3 },
      { radiusKm: 1.0, kRing: 2, count: 5 },
    ]);
    expect(view.rings[0]).not.toHaveProperty('driverCount');
    // Las posiciones reales se pasan tal cual (passthrough) para plotear en el mapa.
    expect(view.drivers).toEqual(positions);
    expect(() => radarPreview.parse(view)).not.toThrow();
  });

  it('degrada honesto a drivers:[] si un dispatch viejo no sirve la muestra de posiciones', async () => {
    const { svc, rest } = make();
    rest.get.mockResolvedValue({
      mode: 'FIXED',
      center: { lat: -12.05, lon: -77.04 },
      rings: [{ radiusKm: 0.5, kRing: 1, driverCount: 3 }],
      totalInRange: 3,
      // sin `drivers`
    });
    const view = await svc.radarPreview(operator, 'FIXED', -12.05, -77.04);
    expect(view.drivers).toEqual([]);
    expect(() => radarPreview.parse(view)).not.toThrow();
  });
});

describe('DispatchConfigService — carpooling vía REST_BOOKING', () => {
  it('getCarpoolConfig lee de booking-service (NO de dispatch)', async () => {
    const { svc, rest, bookingRest } = make();
    bookingRest.get.mockResolvedValue({
      baseRadiusKm: 0.8,
      expandRadiusKm: 1.5,
      version: 2,
      updatedAt: '2026-06-20T12:00:00.000Z',
    });
    const view = await svc.getCarpoolConfig(operator);
    expect(bookingRest.get).toHaveBeenCalledWith(
      '/internal/booking/search-radius-config',
      expect.objectContaining({ identity: operator }),
    );
    expect(rest.get).not.toHaveBeenCalled();
    expect(() => carpoolSearchConfigView.parse(view)).not.toThrow();
  });

  it('replaceCarpoolConfig hace PUT a booking-service + audita con la acción del carpooling', async () => {
    const { svc, rest, bookingRest, audit } = make();
    bookingRest.put.mockResolvedValue({
      baseRadiusKm: 0.8,
      expandRadiusKm: 1.5,
      version: 3,
      updatedAt: '2026-06-21T12:00:00.000Z',
    });
    const view = await svc.replaceCarpoolConfig(operator, {
      baseRadiusKm: 0.8,
      expandRadiusKm: 1.5,
    } as never);
    expect(bookingRest.put).toHaveBeenCalledWith(
      '/internal/booking/search-radius-config',
      expect.objectContaining({
        identity: operator,
        body: { baseRadiusKm: 0.8, expandRadiusKm: 1.5 },
      }),
    );
    expect(rest.put).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      operator,
      expect.objectContaining({
        action: 'dispatch.carpool_radius_config_replace',
        resourceType: 'carpool_search_radius_config',
        resourceId: '3',
        payload: expect.objectContaining({ baseRadiusKm: 0.8, expandRadiusKm: 1.5, version: 3 }),
      }),
    );
    expect(() => carpoolSearchConfigView.parse(view)).not.toThrow();
  });

  it('carpoolRadar lee el radar de booking (passthrough count) con lat/lon', async () => {
    const { svc, bookingRest } = make();
    const origins = [{ lat: -12.05, lon: -77.04 }];
    bookingRest.get.mockResolvedValue({
      center: { lat: -12.05, lon: -77.04 },
      rings: [{ radiusKm: 0.8, kRing: 2, count: 4 }],
      totalInRange: 4,
      drivers: origins,
    });
    const view = await svc.carpoolRadar(operator, -12.05, -77.04);
    expect(bookingRest.get).toHaveBeenCalledWith(
      '/internal/booking/radar-preview',
      expect.objectContaining({ query: { lat: -12.05, lon: -77.04 } }),
    );
    expect(view.mode).toBeUndefined();
    expect(view.rings).toEqual([{ radiusKm: 0.8, kRing: 2, count: 4 }]);
    // Los orígenes reales de las ofertas se pasan tal cual para plotear en el mapa.
    expect(view.drivers).toEqual(origins);
    expect(() => radarPreview.parse(view)).not.toThrow();
  });
});
