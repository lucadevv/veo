import { Module } from '@nestjs/common';
import { HeatmapController } from './heatmap.controller';
import { HeatmapService } from './heatmap.service';

@Module({
  controllers: [HeatmapController],
  providers: [HeatmapService],
})
export class HeatmapModule {}
