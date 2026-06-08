/**
 * Puerto de mapas (FOUNDATION §0.7: self-hosted, NO Google). Provee un `MapsClient` de @veo/maps
 * para calcular ETA en el scoring (BR-T06). Modo seleccionable por env (`osrm` prod, `local` dev/CI).
 */
import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createMapsClient, type MapsClient } from '@veo/maps';
import type { Env } from '../../config/env.schema';

export const MAPS_CLIENT = Symbol('MAPS_CLIENT');

const mapsProvider: Provider = {
  provide: MAPS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): MapsClient => {
    const mode = config.getOrThrow<'osrm' | 'local'>('VEO_MAPS_MODE');
    return createMapsClient({
      mode,
      osrm: {
        osrmBaseUrl: config.getOrThrow<string>('OSRM_BASE_URL'),
        nominatimBaseUrl: config.getOrThrow<string>('NOMINATIM_BASE_URL'),
        cacheTtlSeconds: config.getOrThrow<number>('MAPS_CACHE_TTL_SECONDS'),
      },
    });
  },
};

@Global()
@Module({ providers: [mapsProvider], exports: [MAPS_CLIENT] })
export class MapsModule {}
