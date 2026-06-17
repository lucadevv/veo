/**
 * AnalyticsService — lecturas agregadas del estado caliente de dispatch para el dashboard admin.
 *
 * Clean arch: depende del PUERTO `HotIndex` (interfaz), no de Redis/ioredis directo. El conteo de
 * "online" es una propiedad del índice de conductores, así que vive detrás de ese puerto y aquí solo
 * se orquesta la lectura. Sin Postgres ni joins: la fuente de verdad del estado en vivo es el hot index.
 */
import { Inject, Injectable } from '@nestjs/common';
import { HOT_INDEX, type HotIndex } from '../hot-index/hot-index.port';

@Injectable()
export class AnalyticsService {
  constructor(@Inject(HOT_INDEX) private readonly hotIndex: HotIndex) {}

  /** Cantidad de conductores en línea ahora (KPI del dashboard admin). */
  async onlineDrivers(): Promise<number> {
    return this.hotIndex.countOnline();
  }
}
