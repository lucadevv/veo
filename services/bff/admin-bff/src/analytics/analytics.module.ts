import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { ClickHouseService } from './clickhouse.service';

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService, ClickHouseService],
})
export class AnalyticsModule {}
