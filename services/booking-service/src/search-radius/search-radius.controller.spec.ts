/**
 * SearchRadiusController (F2 · endpoints internos del radio de búsqueda). Verifica la forma de cada endpoint
 * (GET/PUT config + radar-preview) delegando en fakes, y el AdminIdentityGuard del PUT (defensa en profundidad:
 * solo identidad `admin` muta). No levanta Nest — construye el controller/guard directo (convención vitest).
 */
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '@veo/utils';
import type { ExecutionContext } from '@nestjs/common';
import { SearchRadiusController } from './search-radius.controller';
import { AdminIdentityGuard } from './admin-identity.guard';
import type { CarpoolSearchConfigService } from './carpool-search-config.service';
import type { PublishedTripsService, RadarPreview } from '../published-trips/published-trips.service';
import type { PersistedSearchConfig } from './carpool-search-config.repository';

function makeController(over: {
  getConfig?: () => Promise<PersistedSearchConfig>;
  replaceConfig?: (input: { baseRadiusKm: number; expandRadiusKm: number }) => Promise<PersistedSearchConfig>;
  radarPreview?: (lat: number, lon: number) => Promise<RadarPreview>;
} = {}) {
  const getConfig = vi.fn(
    over.getConfig ??
      (async () => ({ baseRadiusKm: 0.3, expandRadiusKm: 0.6, version: 2, updatedAt: new Date(0).toISOString() })),
  );
  const replaceConfig = vi.fn(
    over.replaceConfig ??
      (async (input) => ({ ...input, version: 3, updatedAt: new Date(0).toISOString() })),
  );
  const radarPreview = vi.fn(
    over.radarPreview ??
      (async (lat: number, lon: number) => ({
        center: { lat, lon },
        rings: [
          { radiusKm: 0.3, kRing: 1, count: 0 },
          { radiusKm: 0.6, kRing: 2, count: 0 },
        ],
        totalInRange: 0,
        drivers: [],
      })),
  );
  const searchConfig = { getConfig, replaceConfig } as unknown as CarpoolSearchConfigService;
  const publishedTrips = { radarPreview } as unknown as PublishedTripsService;
  const controller = new SearchRadiusController(searchConfig, publishedTrips);
  return { controller, getConfig, replaceConfig, radarPreview };
}

/** ExecutionContext mínimo con un `req.user` dado (lo que el AdminIdentityGuard inspecciona). */
function ctxWithUser(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('SearchRadiusController (F2 · endpoints internos del radio)', () => {
  it('GET search-radius-config → { baseRadiusKm, expandRadiusKm, version, updatedAt }', async () => {
    const { controller, getConfig } = makeController();
    const out = await controller.getConfig();
    expect(getConfig).toHaveBeenCalledOnce();
    expect(out).toEqual({
      baseRadiusKm: 0.3,
      expandRadiusKm: 0.6,
      version: 2,
      updatedAt: new Date(0).toISOString(),
    });
  });

  it('PUT search-radius-config delega el body {baseRadiusKm, expandRadiusKm} y devuelve la config actualizada', async () => {
    const { controller, replaceConfig } = makeController();
    const out = await controller.replaceConfig({ baseRadiusKm: 0.9, expandRadiusKm: 1.2 });
    expect(replaceConfig).toHaveBeenCalledWith({ baseRadiusKm: 0.9, expandRadiusKm: 1.2 });
    expect(out).toMatchObject({ baseRadiusKm: 0.9, expandRadiusKm: 1.2, version: 3 });
  });

  it('GET radar-preview delega lat/lon y devuelve { center, rings, totalInRange }', async () => {
    const { controller, radarPreview } = makeController();
    const out = await controller.radarPreview({ lat: -12.05, lon: -77.04 });
    expect(radarPreview).toHaveBeenCalledWith(-12.05, -77.04);
    expect(out.center).toEqual({ lat: -12.05, lon: -77.04 });
    expect(out.rings).toHaveLength(2);
    expect(out.totalInRange).toBe(0);
    expect(out.drivers).toEqual([]);
  });
});

describe('AdminIdentityGuard (PUT · defensa en profundidad)', () => {
  const guard = new AdminIdentityGuard();

  it('permite una identidad admin', () => {
    expect(guard.canActivate(ctxWithUser({ type: 'admin' }))).toBe(true);
  });

  it('rechaza una identidad NO admin (ForbiddenError)', () => {
    expect(() => guard.canActivate(ctxWithUser({ type: 'driver' }))).toThrow(ForbiddenError);
  });

  it('rechaza si no hay identidad (req.user undefined)', () => {
    expect(() => guard.canActivate(ctxWithUser(undefined))).toThrow(ForbiddenError);
  });
});
