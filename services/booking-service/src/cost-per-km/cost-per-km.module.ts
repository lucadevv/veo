/**
 * CostPerKmConfigModule (F2.5) — el costo de OPERACIÓN por km, editable en caliente por el admin, por país.
 * Expone CostPerKmConfigService (lo inyecta CostCapService para resolver el costo/km del tope) y el endpoint
 * interno admin (GET/PUT). Espeja el wiring de CommissionModule de payment-service.
 *
 * Reemplaza la maquinaria de energía vieja (CostPerKmService + InternalRestClient a trip-service +
 * PricingCacheConsumer de energy.catalog_updated): el costo/km ya NO se deriva del precio de energía, lo fija
 * el admin directo. El env COST_PER_KM_CENTS_PE/EC queda solo como FALLBACK de degradación honesta.
 */
import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CostPerKmConfigService,
  COST_PER_KM_ENV_FALLBACK,
  COST_PER_KM_CACHE_TTL_MS,
} from './cost-per-km-config.service';
import {
  COST_PER_KM_CONFIG_REPO,
  PrismaCostPerKmConfigRepository,
} from './cost-per-km-config.repository';
import { CostPerKmController } from './cost-per-km.controller';
import { PAIS, type CostPerKmConfig } from '../domain/cost-cap';
import type { Env } from '../config/env.schema';

/**
 * Objeto de FALLBACK del costo/km por país desde env (COST_PER_KM_CENTS_PE/EC). NO es la fuente de primera
 * mano (esa es la DB, editable por el admin): solo alimenta la degradación honesta si la config no está.
 */
const envFallbackProvider: Provider = {
  provide: COST_PER_KM_ENV_FALLBACK,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): CostPerKmConfig => ({
    [PAIS.PE]: config.getOrThrow<number>('COST_PER_KM_CENTS_PE'),
    [PAIS.EC]: config.getOrThrow<number>('COST_PER_KM_CENTS_EC'),
  }),
};

/** TTL del cache in-proc del costo/km (ms). Slot corto por país; el PUT invalida su réplica de inmediato. */
const cacheTtlProvider: Provider = {
  provide: COST_PER_KM_CACHE_TTL_MS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): number =>
    config.getOrThrow<number>('COST_PER_KM_CACHE_TTL_MS'),
};

@Module({
  providers: [
    CostPerKmConfigService,
    { provide: COST_PER_KM_CONFIG_REPO, useClass: PrismaCostPerKmConfigRepository },
    envFallbackProvider,
    cacheTtlProvider,
  ],
  controllers: [CostPerKmController],
  exports: [CostPerKmConfigService],
})
export class CostPerKmConfigModule {}
