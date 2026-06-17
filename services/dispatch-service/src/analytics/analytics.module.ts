import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/**
 * Analytics internos de dispatch para el dashboard admin (KPIs del estado en vivo). Reusa el hot index
 * (HotIndexModule es @Global, así que HOT_INDEX se inyecta sin reimportarlo) como fuente de verdad.
 */
@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
