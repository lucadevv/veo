import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

// Los REST_* (trip/dispatch/panic/payment) los provee InfraModule (@Global). ClickHouseService quedó
// fuera del overview (migró a agregación OLTP) — sigue disponible para gps/OLAP futuro (DEUDA marcada ahí).
@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
