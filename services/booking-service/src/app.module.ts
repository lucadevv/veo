import { Module, type Provider } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import {
  HealthController,
  MetricsController,
  READINESS_CHECKS,
  type ReadinessCheck,
} from '@veo/observability';
import type { Redis } from '@veo/redis';
import { validateEnv } from './config/env.schema';
import { CoreModule } from './infra/core.module';
import { PrismaService } from './infra/prisma.service';
import { REDIS } from './infra/redis';
import { KAFKA_HEALTH, type KafkaHealthClient } from './infra/kafka-health';
import { PublishedTripsModule } from './published-trips/published-trips.module';
import { BookingsModule } from './bookings/bookings.module';

// Readiness: la sonda /health/ready verifica las dependencias DURAS del booking-service en F0:
//  - postgres: el agregado (PublishedTrip/Booking) y el outbox viven acá; sin DB el servicio no opera.
//  - kafka: el OutboxRelay drena los eventos de dominio al topic 'booking' (FOUNDATION §6) — sin broker
//    los eventos no salen y los consumidores aguas abajo no avanzan; es dependencia dura, no opcional.
//  - redis: cliente compartido cableado en CoreModule (gates/locks de fases futuras). El check es barato
//    (PING) y mantiene honesta la sonda: si el provider está, el readiness lo refleja (no se difiere mudo).
// Los puertos gRPC SALIENTES (identity/payment) son consumo de F1/F3 y NO entran al readiness de F0.
const readinessProvider: Provider = {
  provide: READINESS_CHECKS,
  inject: [PrismaService, KAFKA_HEALTH, REDIS],
  useFactory: (
    prisma: PrismaService,
    kafkaHealth: KafkaHealthClient,
    redis: Redis,
  ): ReadinessCheck[] => [
    {
      name: 'postgres',
      check: async () => {
        await prisma.read.$queryRaw`SELECT 1`;
        return true;
      },
    },
    {
      name: 'kafka',
      check: () => kafkaHealth.isHealthy(),
    },
    {
      name: 'redis',
      check: async () => (await redis.ping()) === 'PONG',
    },
  ],
};

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    ScheduleModule.forRoot(),
    CoreModule,
    PublishedTripsModule,
    BookingsModule,
  ],
  // HealthController/MetricsController compartidos de @veo/observability exponen GET /health,
  // /health/ready y /metrics (fuera del prefijo global, ver main.ts). Mismo patrón que identity-service.
  controllers: [HealthController, MetricsController],
  providers: [readinessProvider],
})
export class AppModule {}
