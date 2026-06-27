/**
 * PricingModule (ADR 011) — schedule de modo de pricing: el ModeResolver (vía PricingScheduleService),
 * sus endpoints internos y el adaptador Prisma del singleton. Exporta PricingScheduleService para que
 * TripsService lo consuma en createTrip (resolve-once-persist-forever).
 */
import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PricingController } from './pricing.controller';
import { PricingScheduleService, PRICING_SCHEDULE_CACHE_TTL_MS } from './pricing-schedule.service';
import { FuelSurchargeService, FUEL_SURCHARGE_CACHE_TTL_MS } from './fuel-surcharge.service';
import { EnergyCatalogService, ENERGY_CATALOG_CACHE_TTL_MS } from './energy-catalog.service';
import { BidFloorService, BID_FLOOR_CACHE_TTL_MS } from './bid-floor.service';
import { BaseFareService, BASE_FARE_CACHE_TTL_MS } from './base-fare.service';
import { PricingCacheConsumer } from './pricing-cache.consumer';
import { EnergyModelBootGuard } from './energy-model-boot.guard';
import { AdminIdentityGuard } from './admin-identity.guard';
import { CatalogModule } from '../catalog/catalog.module';
import {
  PRICING_SCHEDULE_REPO,
  PrismaPricingScheduleRepository,
} from './pricing-schedule.repository';
import { FUEL_SURCHARGE_REPO, PrismaFuelSurchargeRepository } from './fuel-surcharge.repository';
import { ENERGY_CATALOG_REPO, PrismaEnergyCatalogRepository } from './energy-catalog.repository';
import { BID_FLOOR_REPO, PrismaBidFloorRepository } from './bid-floor.repository';
import { BASE_FARE_REPO, PrismaBaseFareRepository } from './base-fare.repository';
import type { Env } from '../config/env.schema';

// S3 — TTL (ms) del cache del schedule, desde PRICING_SCHEDULE_CACHE_TTL_MS (default 10s en el schema).
const scheduleCacheTtlProvider: Provider = {
  provide: PRICING_SCHEDULE_CACHE_TTL_MS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    config.getOrThrow<number>('PRICING_SCHEDULE_CACHE_TTL_MS'),
};

// B3 — el recargo de combustible comparte el perfil de staleness del schedule → REUSA su TTL (sin env nuevo).
const fuelCacheTtlProvider: Provider = {
  provide: FUEL_SURCHARGE_CACHE_TTL_MS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    config.getOrThrow<number>('PRICING_SCHEDULE_CACHE_TTL_MS'),
};

// B5 — el catálogo de energía comparte el mismo perfil de staleness → REUSA el TTL del schedule (sin env nuevo).
const energyCacheTtlProvider: Provider = {
  provide: ENERGY_CATALOG_CACHE_TTL_MS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    config.getOrThrow<number>('PRICING_SCHEDULE_CACHE_TTL_MS'),
};

// ADR 010 §9.3 — el piso de la puja comparte el mismo perfil de staleness → REUSA el TTL del schedule (sin env nuevo).
const bidFloorCacheTtlProvider: Provider = {
  provide: BID_FLOOR_CACHE_TTL_MS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    config.getOrThrow<number>('PRICING_SCHEDULE_CACHE_TTL_MS'),
};

// F2.4 — la tarifa base comparte el mismo perfil de staleness → REUSA el TTL del schedule (sin env nuevo).
const baseFareCacheTtlProvider: Provider = {
  provide: BASE_FARE_CACHE_TTL_MS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    config.getOrThrow<number>('PRICING_SCHEDULE_CACHE_TTL_MS'),
};

@Module({
  // CatalogModule exporta CatalogService → el PricingCacheConsumer lo inyecta para invalidar
  // su cache ante `catalog.updated` (el cuarto cache de config editable en caliente).
  imports: [CatalogModule],
  controllers: [PricingController],
  providers: [
    PricingScheduleService,
    FuelSurchargeService,
    EnergyCatalogService,
    BidFloorService,
    BaseFareService,
    // Invalidación instantánea cross-réplica del cache de los 5 servicios de config (arranca en
    // onModuleInit del bootstrap Kafka; PricingModule está en el grafo vía TripsModule → AppModule).
    PricingCacheConsumer,
    // F2.1b · fail-fast al arranque: flip ON + catálogo de energía sin poblar → no levanta (anti cobro-de-menos).
    EnergyModelBootGuard,
    AdminIdentityGuard,
    scheduleCacheTtlProvider,
    fuelCacheTtlProvider,
    energyCacheTtlProvider,
    bidFloorCacheTtlProvider,
    baseFareCacheTtlProvider,
    // Puerto → adaptador Prisma (clean arch: el servicio depende de la interfaz, no de la clase).
    { provide: PRICING_SCHEDULE_REPO, useClass: PrismaPricingScheduleRepository },
    { provide: FUEL_SURCHARGE_REPO, useClass: PrismaFuelSurchargeRepository },
    { provide: ENERGY_CATALOG_REPO, useClass: PrismaEnergyCatalogRepository },
    { provide: BID_FLOOR_REPO, useClass: PrismaBidFloorRepository },
    { provide: BASE_FARE_REPO, useClass: PrismaBaseFareRepository },
  ],
  exports: [
    PricingScheduleService,
    FuelSurchargeService,
    EnergyCatalogService,
    BidFloorService,
    BaseFareService,
  ],
})
export class PricingModule {}
