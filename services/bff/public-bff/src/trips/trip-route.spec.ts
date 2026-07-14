/**
 * Test de la ruta del viaje del pasajero (TripsService.route).
 * Reglas de negocio cubiertas (decisión: ruta canónica del viaje):
 *  - Con ruta PERSISTIDA por trip-service (routePolyline): se sirve TAL CUAL (polyline + distancia/
 *    duración persistidas, steps vacíos) SIN recomputar — una sola verdad para todos los consumidores.
 *  - SIN ruta persistida (viajes viejos / facade caído al crear): FALLBACK al cómputo por fase previo
 *    (pre-recojo SOLO driver→recojo; onboard driver→paradas→destino; sin ubicación del conductor:
 *    onboard degrada a recojo→destino y pre-recojo devuelve ruta VACÍA).
 *  - Ownership anti-IDOR ANTES de servir/calcular nada.
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
  /** Ruta canónica persistida por trip-service; null = viaje sin ruta (viejo / facade caído) → fallback. */
  routePolyline?: string | null;
}) {
  const get = vi.fn().mockResolvedValue({
    id: 'trip-1',
    passengerId: opts.passengerId ?? 'usr-1',
    status: opts.status,
    origin: ORIGIN,
    destination: DESTINATION,
    waypoints: opts.waypoints ?? [],
    routePolyline: opts.routePolyline ?? null,
    distanceMeters: 8000,
    durationSeconds: 960,
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

describe('TripsService.route — ruta CANÓNICA persistida por trip-service', () => {
  it('con ruta persistida: la SIRVE tal cual (polyline + distancia/duración persistidas) SIN recomputar', async () => {
    const { svc, routeWithSteps } = makeService({
      status: 'IN_PROGRESS',
      driverAt: DRIVER_AT,
      waypoints: [WAYPOINT],
      routePolyline: 'canonica_persistida',
    });
    const view = await svc.route(user, 'trip-1');
    // Cero recomputo: el facade de mapas NO se toca aunque haya ubicación viva del conductor.
    expect(routeWithSteps).not.toHaveBeenCalled();
    expect(view.polyline).toBe('canonica_persistida');
    expect(view.distanceMeters).toBe(8000);
    expect(view.durationSeconds).toBe(960);
    // La canónica no trae navegación turn-by-turn (eso es del conductor): steps vacíos.
    expect(view.steps).toEqual([]);
    // Los markers son SIEMPRE los del viaje.
    expect(view.origin).toEqual(ORIGIN);
    expect(view.destination).toEqual(DESTINATION);
    expect(view.waypoints).toEqual([WAYPOINT]);
  });

  it('con ruta persistida también PRE-RECOJO: el overview canónico manda (cambio de semántica documentado)', async () => {
    const { svc, routeWithSteps } = makeService({
      status: 'ACCEPTED',
      driverAt: DRIVER_AT,
      routePolyline: 'canonica_persistida',
    });
    const view = await svc.route(user, 'trip-1');
    expect(routeWithSteps).not.toHaveBeenCalled();
    expect(view.polyline).toBe('canonica_persistida');
  });

  it('anti-IDOR: con ruta persistida el viaje de OTRO pasajero → Forbidden sin servir nada', async () => {
    const { svc } = makeService({
      status: 'ACCEPTED',
      passengerId: 'usr-OTRO',
      routePolyline: 'canonica_persistida',
    });
    await expect(svc.route(user, 'trip-1')).rejects.toMatchObject({ name: 'ForbiddenError' });
  });
});

describe('TripsService.route — FALLBACK por fase (viaje SIN ruta persistida)', () => {
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
