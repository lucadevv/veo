/**
 * Cron diario (ScheduleModule) que recalcula TODOS los agregados con la ventana deslizante
 * y re-evalúa los flags (BR-D01/BR-I05). Esto captura las calificaciones que "salen" de la
 * ventana de 30 días aunque no llegue ningún rating nuevo del sujeto.
 *
 * Lock distribuido en Redis: en despliegues multi-réplica solo una instancia ejecuta el barrido.
 * La expresión se toma de RECOMPUTE_CRON (env) en tiempo de carga del decorador.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type Redis from 'ioredis';
import { REDIS } from '../infra/redis';
import { RatingsService } from './ratings.service';

const LOCK_KEY = 'veo:rating:recompute:lock';
const LOCK_TTL_SECONDS = 15 * 60; // 15 min: cota superior del barrido

@Injectable()
export class RatingRecomputeCron {
  private readonly logger = new Logger(RatingRecomputeCron.name);

  constructor(
    private readonly ratings: RatingsService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Cron(process.env.RECOMPUTE_CRON ?? '0 10 3 * * *', { name: 'rating-recompute' })
  async handleDailyRecompute(): Promise<void> {
    const acquired = await this.redis.set(LOCK_KEY, '1', 'EX', LOCK_TTL_SECONDS, 'NX');
    if (acquired !== 'OK') {
      this.logger.debug('recálculo diario: otra réplica tiene el lock, se omite');
      return;
    }
    try {
      const processed = await this.ratings.recomputeAll();
      this.logger.log(`recálculo diario completado: ${processed} agregados`);
    } catch (err) {
      this.logger.error({ err }, 'recálculo diario falló');
    } finally {
      await this.redis.del(LOCK_KEY);
    }
  }
}
