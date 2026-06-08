/**
 * MetricsController: expone GET /metrics en formato Prometheus.
 * Importar MetricsModule en el AppModule de cada servicio.
 */
import { Controller, Get, Header, Module } from '@nestjs/common';
import { metricsRegistry } from './metrics.js';

@Controller('metrics')
export class MetricsController {
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async scrape(): Promise<string> {
    return metricsRegistry.metrics();
  }
}

@Module({ controllers: [MetricsController] })
export class MetricsModule {}
