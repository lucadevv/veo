/**
 * Test de la ruta POR FASE del pasajero (TripsService.route): la costura espejo del driver-bff.
 * Reglas de negocio cubiertas: pre-recojo traza SOLO driver→recojo (la ruta al destino no se muestra
 * en ese estado — regla del dueño, espejo del mapa del conductor); onboard (IN_PROGRESS)
 * driver→paradas→destino; sin ubicación del conductor: onboard degrada a recojo→destino y
 * pre-recojo devuelve ruta VACÍA; ownership anti-IDOR ANTES de calcular nada.
 */
import { describe, it, expect, vi } from 'vitest';
import { InternalAudience, type AuthenticatedUser } from '@veo/auth';
import type { GrpcServiceClient, InternalRestClient } from '@veo/rpc';
import { TripsService } from './trips.service';
import type { DriverEnrichmentService } from './driver-enrichment.service';
import type { DispatchService } from '../dispatch/dispatch.service';
import type { LiveKitConfig } from '../share/livekit-token';

const SECRET = 'dev-internal-secret-change-me';
const livekit: LiveKitConfig = {
  url: 'ws://localhost:7880',
  apiKey: 'devkey',
  apiSecret: 'devsecret_change_in_production',
  ttlSec: 3600,
};
const user: AuthenticatedUser = { userId: 'usr-1', type: 'passenger', roles: [], sessionId: 's1' };

const ORIGIN = { lat: -12.046, lon: -77.043 };
const DESTINATION = { lat: -12.121, lon: -77.03 };
const WAYPOINT = { lat: -12.09, lon: -77.04 };
const DRIVER_AT = { lat: -12.05, lon: -77.05 };

function makeService(opts: {
  status: string;
  passengerId?: string;
  waypoints?: { lat: number; lon: number }[];
  driverAt?: { lat: number; lon: number };
}) {
  const get = vi.fn().mockResolvedValue({
    id: 'trip-1',
    passengerId: opts.passengerId ?? 'usr-1',
    status: opts.status,
    origin: ORIGIN,
    destination: DESTINATION,
    waypoints: opts.waypoints ?? [],
  });
  const tripRest = { get } as unknown as InternalRestClient;
  const routeWithSteps = vi.fn().mockResolvedValue({
    polyline: 'poly',
    distanceMeters: 1200,
    durationSeconds: 300,
    steps: [
      { instruction: 'Inicia el recorrido', distanceMeters: 1200, maneuver: 'depart', geometryPolyline: 'p1' },
    ],
  });
  const stub = {} as unknown as GrpcServiceClient;
  const restStub = {} as unknown as InternalRestClient;
  const svc = new TripsService(
    stub,
    stub,
    stub,
    stub,
    stub,
    tripRest,
    restStub,
    restStub,
    restStub,
    livekit,
    SECRET,
    InternalAudience.PUBLIC_RAIL,
    { get: async () => null, set: async () => 'OK' } as never, // REDIS — no usado acá
    { routeWithSteps } as never, // MAPS (@veo/maps)
    {} as unknown as DriverEnrichmentService,
    {} as unknown as DispatchService,
    {
      getLocation: () => (opts.driverAt ? { point: opts.driverAt, at: '2026-07-13T00:00:00Z' } : undefined),
    } as never, // RealtimeStateService
  );
  return { svc, routeWithSteps, get };
}

describe('TripsService.route — ruta por fase del pasajero', () => {
  it('PRE-RECOJO con conductor vivo: traza SOLO driver → recojo (sin destino ni paradas)', async () => {
    const { svc, routeWithSteps } = makeService({
      status: 'ACCEPTED',
      driverAt: DRIVER_AT,
      waypoints: [WAYPOINT],
    });
    const view = await svc.route(user, 'trip-1');
    expect(routeWithSteps).toHaveBeenCalledWith(DRIVER_AT, ORIGIN, []);
    // Los markers son SIEMPRE los del viaje (la ubicación viva no cambia qué se pinta).
    expect(view.origin).toEqual(ORIGIN);
    expect(view.destination).toEqual(DESTINATION);
    expect(view.steps[0]?.instruction).toBe('Inicia el recorrido');
  });

  it('ONBOARD (IN_PROGRESS): el recojo se cae de la geometría — driver → paradas → destino', async () => {
    const { svc, routeWithSteps } = makeService({
      status: 'IN_PROGRESS',
      driverAt: DRIVER_AT,
      waypoints: [WAYPOINT],
    });
    await svc.route(user, 'trip-1');
    expect(routeWithSteps).toHaveBeenCalledWith(DRIVER_AT, DESTINATION, [WAYPOINT]);
  });

  it('SIN ubicación del conductor en PRE-RECOJO: ruta VACÍA (no se pinta el tramo equivocado)', async () => {
    const { svc, routeWithSteps } = makeService({ status: 'ACCEPTED' });
    const view = await svc.route(user, 'trip-1');
    expect(routeWithSteps).not.toHaveBeenCalled();
    expect(view.polyline).toBe('');
    expect(view.steps).toEqual([]);
  });

  it('SIN ubicación del conductor ONBOARD: degradación honesta recojo → destino (mismo tramo B→C)', async () => {
    const { svc, routeWithSteps } = makeService({ status: 'IN_PROGRESS', waypoints: [WAYPOINT] });
    await svc.route(user, 'trip-1');
    expect(routeWithSteps).toHaveBeenCalledWith(ORIGIN, DESTINATION, [WAYPOINT]);
  });

  it('anti-IDOR: el viaje de OTRO pasajero → Forbidden sin calcular la ruta', async () => {
    const { svc, routeWithSteps } = makeService({
      status: 'ACCEPTED',
      passengerId: 'usr-OTRO',
      driverAt: DRIVER_AT,
    });
    await expect(svc.route(user, 'trip-1')).rejects.toMatchObject({ name: 'ForbiddenError' });
    expect(routeWithSteps).not.toHaveBeenCalled();
  });
});
