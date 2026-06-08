/**
 * PricingModule (ADR 011) — schedule de modo de pricing: el ModeResolver (vía PricingScheduleService),
 * sus endpoints internos y el adaptador Prisma del singleton. Exporta PricingScheduleService para que
 * TripsService lo consuma en createTrip (resolve-once-persist-forever).
 */
import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PricingController } from './pricing.controller';
import {
  PricingScheduleService,
  PRICING_SCHEDULE_CACHE_TTL_MS,
} from './pricing-schedule.service';
import { AdminIdentityGuard } from './admin-identity.guard';
import {
  PRICING_SCHEDULE_REPO,
  PrismaPricingScheduleRepository,
} from './pricing-schedule.repository';
import type { Env } from '../config/env.schema';

// S3 — TTL (ms) del cache del schedule, desde PRICING_SCHEDULE_CACHE_TTL_MS (default 10s en el schema).
const scheduleCacheTtlProvider: Provider = {
  provide: PRICING_SCHEDULE_CACHE_TTL_MS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    config.getOrThrow<number>('PRICING_SCHEDULE_CACHE_TTL_MS'),
};

@Module({
  controllers: [PricingController],
  providers: [
    PricingScheduleService,
    AdminIdentityGuard,
    scheduleCacheTtlProvider,
    // Puerto → adaptador Prisma (clean arch: el servicio depende de la interfaz, no de la clase).
    { provide: PRICING_SCHEDULE_REPO, useClass: PrismaPricingScheduleRepository },
  ],
  exports: [PricingScheduleService],
})
export class PricingModule {}
