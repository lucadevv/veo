import { Module } from '@nestjs/common';
import { HeatmapController } from './heatmap.controller';
import { HeatmapService } from './heatmap.service';

/**
 * Mapa de calor de demanda (Ola 2C). Vive en dispatch-service: reusa el consumo de `trip.requested`,
 * la lógica H3 y el Redis del hot index. Exporta el servicio para que el consumidor Kafka registre
 * la demanda al vuelo.
 */
@Module({
  controllers: [HeatmapController],
  providers: [HeatmapService],
  exports: [HeatmapService],
})
export class HeatmapModule {}
