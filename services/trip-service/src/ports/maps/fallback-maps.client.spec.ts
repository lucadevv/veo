/**
 * Degradación honesta del puerto de mapas (ruta canónica del viaje): el proveedor externo caído
 * (ExternalServiceError) NO rompe la operación — cae al motor local, que estima distancia/duración
 * (la tarifa sigue calculable) y devuelve polyline '' (→ routePolyline persistida null, jamás
 * inventada). Un error que NO es del proveedor es un bug y se propaga tal cual.
 */
import { describe, it, expect, vi } from 'vitest';
import { ExternalServiceError } from '@veo/utils';
import type { MapsClient, RouteResult } from '@veo/maps';
import { FallbackMapsClient } from './fallback-maps.client';

const ORIGIN = { lat: -12.0464, lon: -77.0428 };
const DESTINATION = { lat: -12.1219, lon: -77.0297 };
const WAYPOINT = { lat: -12.09, lon: -77.04 };

const REAL_ROUTE: RouteResult = {
  distanceMeters: 9200,
  durationSeconds: 1100,
  polyline: 'polyline_real_del_proveedor',
  geometry: { type: 'LineString', coordinates: [] },
};

function primaryOf(route: MapsClient['route']): MapsClient {
  return { route } as unknown as MapsClient;
}

describe('FallbackMapsClient.route — degradación honesta del proveedor de mapas', () => {
  it('proveedor sano: passthrough — devuelve la ruta REAL (polyline incluida) sin tocar el fallback', async () => {
    const route = vi.fn().mockResolvedValue(REAL_ROUTE);
    const client = new FallbackMapsClient(primaryOf(route));

    const result = await client.route(ORIGIN, DESTINATION, [WAYPOINT]);

    expect(result).toEqual(REAL_ROUTE);
    // Las paradas llegan INTACTAS al primario (el bug histórico del public-bff era descartarlas).
    expect(route).toHaveBeenCalledWith(ORIGIN, DESTINATION, [WAYPOINT]);
  });

  it('proveedor caído (ExternalServiceError): cae al motor local — estima distancia/duración y polyline VACÍA', async () => {
    const route = vi.fn().mockRejectedValue(new ExternalServiceError('Mapbox caído'));
    const client = new FallbackMapsClient(primaryOf(route));

    const result = await client.route(ORIGIN, DESTINATION);

    // El motor local estima (la tarifa BR-T05 sigue calculable) pero NO inventa geometría:
    // polyline '' → el caller persiste routePolyline null (degradación honesta).
    expect(result.polyline).toBe('');
    expect(result.distanceMeters).toBeGreaterThan(0);
    expect(result.durationSeconds).toBeGreaterThan(0);
  });

  it('proveedor caído CON paradas: el fallback las preserva (la distancia estimada las incluye)', async () => {
    const route = vi.fn().mockRejectedValue(new ExternalServiceError('OSRM caído'));
    const client = new FallbackMapsClient(primaryOf(route));

    const direct = await client.route(ORIGIN, DESTINATION);
    const withStop = await client.route(ORIGIN, DESTINATION, [WAYPOINT]);

    expect(withStop.distanceMeters).toBeGreaterThan(direct.distanceMeters);
  });

  it('un error que NO es del proveedor es un BUG: se propaga, no se degrada en silencio', async () => {
    const boom = new TypeError('bug de programación');
    const route = vi.fn().mockRejectedValue(boom);
    const client = new FallbackMapsClient(primaryOf(route));

    await expect(client.route(ORIGIN, DESTINATION)).rejects.toBe(boom);
  });
});
