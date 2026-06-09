import { describe, it, expect, vi } from 'vitest';
import { ExternalServiceError } from '@veo/utils';
import type { MapsClient, RouteResult } from '@veo/maps';
import { FallbackMapsClient } from './maps.client';

/**
 * Regresión del bug: `FallbackMapsClient.route` declaraba `(origin, destination)` SIN waypoints → el
 * 3er argumento (las paradas) que le pasa maps.service/trips.service se DESCARTABA → la ruta y la tarifa
 * NO cambiaban al agregar una parada en la app. Estos tests lockean que la fachada REENVÍA las paradas
 * tanto al primario como al fallback local.
 */
describe('FallbackMapsClient.route · reenvía los waypoints (no los descarta)', () => {
  const origin = { lat: -12.1211, lon: -77.0297 };
  const destination = { lat: -12.0976, lon: -77.0365 };
  const waypoints = [{ lat: -12.1465, lon: -77.0207 }];

  const okRoute: RouteResult = {
    distanceMeters: 1000,
    durationSeconds: 120,
    polyline: '',
    geometry: { type: 'LineString', coordinates: [] },
  };

  it('pasa los waypoints al PRIMARIO (OSRM)', async () => {
    const primary = { route: vi.fn().mockResolvedValue(okRoute) } as unknown as MapsClient;
    const client = new FallbackMapsClient(primary);

    await client.route(origin, destination, waypoints);

    expect(primary.route).toHaveBeenCalledWith(origin, destination, waypoints);
  });

  it('si el primario cae (ExternalServiceError), el FALLBACK local rutea POR la parada (geometría de 3 puntos)', async () => {
    const primary = {
      route: vi.fn().mockRejectedValue(new ExternalServiceError('osrm down')),
    } as unknown as MapsClient;
    const client = new FallbackMapsClient(primary);

    const out = await client.route(origin, destination, waypoints);

    // El LocalMapsEngine rutea origen→parada→destino → 3 coordenadas (sin el fix, eran 2: parada perdida).
    expect(out.geometry.coordinates).toHaveLength(3);
    // Y la distancia con desvío es mayor que la directa.
    const direct = await client.route(origin, destination);
    expect(out.distanceMeters).toBeGreaterThan(direct.distanceMeters);
  });
});
