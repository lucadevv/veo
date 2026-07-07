/**
 * PricingModule (ADR 023) — config de pricing editable en caliente: tarifa base global (BaseFareService)
 * y piso de la puja (BidFloorService), sus endpoints internos y los adaptadores Prisma de los singletons.
 * YA NO hay schedule/franjas de modo (ADR 011 superseded): el modo vive POR OFERTA en el catálogo.
 * Exporta los servicios para que TripsService los consuma en createTrip.
 */
import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PricingController } from './pricing.controller';
import { BidFloorService, BID_FLOOR_CACHE_TTL_MS } from './bid-floor.service';
import { BaseFareService, BASE_FARE_CACHE_TTL_MS } from './base-fare.service';
import { PricingCacheConsumer } from './pricing-cache.consumer';
import { AdminIdentityGuard } from './admin-identity.guard';
import { CatalogModule } from '../catalog/catalog.module';
import { BID_FLOOR_REPO, PrismaBidFloorRepository } from './bid-floor.repository';
import { BASE_FARE_REPO, PrismaBaseFareRepository } from './base-fare.repository';
import type { Env } from '../config/env.schema';

// ADR 010 §9.3 — el piso de la puja REUSA el env de TTL PRICING_SCHEDULE_CACHE_TTL_MS (perfil de staleness
// compartido; el nombre del env quedó del schedule ya retirado — sin env nuevo).
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
    BidFloorService,
    BaseFareService,
    // Invalidación instantánea cross-réplica del cache de los servicios de config (arranca en
    // onModuleInit del bootstrap Kafka; PricingModule está en el grafo vía TripsModule → AppModule).
    PricingCacheConsumer,
    AdminIdentityGuard,
    bidFloorCacheTtlProvider,
    baseFareCacheTtlProvider,
    // Puerto → adaptador Prisma (clean arch: el servicio depende de la interfaz, no de la clase).
    { provide: BID_FLOOR_REPO, useClass: PrismaBidFloorRepository },
    { provide: BASE_FARE_REPO, useClass: PrismaBaseFareRepository },
  ],
  exports: [BidFloorService, BaseFareService],
})
export class PricingModule {}
