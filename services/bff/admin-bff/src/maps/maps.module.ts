/**
 * Puerto de mapas del admin-bff (FOUNDATION §0.7 soberanía). @veo/maps tras un puerto propio
 * intercambiable — NUNCA Google Maps. Lo usa OpsService para reverse-geocodear origin/destino del
 * DETALLE de viaje (coords → dirección legible). Default dev: 'local' (motor determinista propio, dataset
 * de Lima, sin infra externa). Prod / geocoder full: 'osrm' (OSM self-hosted: OSRM + Nominatim).
 */
import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createMapsClient, RedisMapsCache, type MapsClient } from '@veo/maps';
import type { Redis } from '@veo/redis';
import { REDIS } from '../infra/tokens';
import type { Env } from '../config/env.schema';

export const MAPS_CLIENT = Symbol('MAPS_CLIENT');

const mapsProvider: Provider = {
  provide: MAPS_CLIENT,
  inject: [ConfigService, REDIS],
  useFactory: (config: ConfigService<Env, true>, redis: Redis): MapsClient => {
    const mode = config.getOrThrow<Env['VEO_MAPS_MODE']>('VEO_MAPS_MODE');
    if (mode === 'osrm') {
      return createMapsClient({
        mode: 'osrm',
        osrm: {
          osrmBaseUrl: config.getOrThrow<string>('OSRM_BASE_URL'),
          nominatimBaseUrl: config.getOrThrow<string>('NOMINATIM_BASE_URL'),
          // Cache Redis del facade (TTL 1h, default del cliente OSRM): el detalle de viaje re-pide la
          // MISMA ruta/reverse en cada refresh del panel — rutas y geocodes son estables, no se
          // re-pega a OSRM/Nominatim por request. El REDIS global lo provee InfraModule (@Global).
          cache: new RedisMapsCache(redis),
        },
      });
    }
    if (mode === 'mapbox') {
      return createMapsClient({
        mode: 'mapbox',
        mapbox: { accessToken: config.getOrThrow<string>('MAPBOX_ACCESS_TOKEN') },
      });
    }
    return createMapsClient({ mode: 'local' });
  },
};

@Module({ providers: [mapsProvider], exports: [MAPS_CLIENT] })
export class MapsModule {}
