/**
 * CarpoolSearchConfigModule (F2) — el radio de búsqueda del carpooling, editable en caliente por el admin.
 * Expone CarpoolSearchConfigService (lo inyecta PublishedTripsService vía SEARCH_RADIUS_READER para resolver
 * los k-rings en runtime) y provee el reader por token. Espeja el wiring del DispatchRadiusConfig de
 * dispatch-service (repo por PUERTO + defaults sembrados del env + TTL del cache).
 *
 * El CONTROLLER interno (GET/PUT config + radar-preview) NO vive acá: lo monta PublishedTripsModule, donde
 * conviven CarpoolSearchConfigService (importado de este módulo) y PublishedTripsService (el radar-preview
 * reusa el índice H3 de published-trips). Así se evita un ciclo de módulos.
 */
import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CarpoolSearchConfigService,
  SEARCH_RADIUS_ENV_DEFAULTS,
  CARPOOL_SEARCH_CONFIG_CACHE_TTL_MS,
  type SearchRadii,
} from './carpool-search-config.service';
import {
  CARPOOL_SEARCH_CONFIG_REPO,
  PrismaCarpoolSearchConfigRepository,
} from './carpool-search-config.repository';
import { H3_RES9_RING_KM } from '../domain/search-radius';
import type { Env } from '../config/env.schema';

/**
 * DEFAULTS del radio (km) SEMBRADOS desde el env de k-rings (SEARCH_H3_K_RING/_EXPAND → km = k × 0.3km/anillo).
 * "env = seed del default de la DB": sin fila persistida el service degrada honesto a ESTOS valores.
 */
const envDefaultsProvider: Provider = {
  provide: SEARCH_RADIUS_ENV_DEFAULTS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): SearchRadii => ({
    baseRadiusKm: config.getOrThrow<number>('SEARCH_H3_K_RING') * H3_RES9_RING_KM,
    expandRadiusKm: config.getOrThrow<number>('SEARCH_H3_K_RING_EXPAND') * H3_RES9_RING_KM,
  }),
};

/** TTL del cache in-proc de la config del radio (ms). Slot corto; el PUT invalida su réplica de inmediato. */
const cacheTtlProvider: Provider = {
  provide: CARPOOL_SEARCH_CONFIG_CACHE_TTL_MS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): number =>
    config.getOrThrow<number>('CARPOOL_SEARCH_CONFIG_CACHE_TTL_MS'),
};

@Module({
  providers: [
    CarpoolSearchConfigService,
    { provide: CARPOOL_SEARCH_CONFIG_REPO, useClass: PrismaCarpoolSearchConfigRepository },
    envDefaultsProvider,
    cacheTtlProvider,
  ],
  exports: [CarpoolSearchConfigService],
})
export class CarpoolSearchConfigModule {}
