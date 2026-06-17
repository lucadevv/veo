/**
 * AnalyticsModule — endpoint interno de stats del dashboard admin (KPIs reales). Clean arch: controller →
 * service → repo (puerto TRIP_STATS_REPO → adaptador Prisma). InternalIdentityGuard es global (CoreModule),
 * así que no se re-provee acá; el @UseGuards del controller lo resuelve del contenedor.
 */
import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { TRIP_STATS_REPO, PrismaTripStatsRepository } from './analytics.repository';

@Module({
  controllers: [AnalyticsController],
  providers: [
    AnalyticsService,
    // Puerto → adaptador Prisma (clean arch: el servicio depende de la interfaz, no de la clase).
    { provide: TRIP_STATS_REPO, useClass: PrismaTripStatsRepository },
  ],
})
export class AnalyticsModule {}
