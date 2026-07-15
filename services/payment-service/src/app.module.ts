import { Module, type Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import {
  HealthController,
  MetricsController,
  READINESS_CHECKS,
  type ReadinessCheck,
} from '@veo/observability';
import { PolicyModule, type PolicyRuntimeConfig } from '@veo/policy/nest';
import type Redis from 'ioredis';
import { validateEnv, type Env } from './config/env.schema';
import { CoreModule } from './infra/core.module';
import { PrismaService } from './infra/prisma.service';
import { REDIS } from './infra/redis';
import { PaymentsModule } from './payments/payments.module';
import { CommissionModule } from './commission/commission.module';
import { AffiliationsModule } from './affiliations/affiliations.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { PromotionsModule } from './promotions/promotions.module';
import { IncentivesModule } from './incentives/incentives.module';
import { PayoutsModule } from './payouts/payouts.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { EventsModule } from './events/events.module';
import { DriverPaymentsModule } from './drivers/driver-payments.module';
import { PaymentGrpcController } from './grpc/payment.grpc.controller';
import {
  PAYMENT_GRPC_REPO,
  PrismaPaymentGrpcRepository,
} from './grpc/payment-grpc.repository';

const readinessProvider: Provider = {
  provide: READINESS_CHECKS,
  inject: [PrismaService, REDIS],
  useFactory: (prisma: PrismaService, redis: Redis): ReadinessCheck[] => [
    {
      name: 'postgres',
      check: async () => {
        await prisma.read.$queryRaw`SELECT 1`;
        return true;
      },
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
    // Cliente runtime de políticas PBAC (ADR-024 Fase 1). GLOBAL (una carga + un consumer Kafka) → el reader
    // cacheado queda visible para el StepUpMfaGuard (auth.stepup en payouts/refunds/commission) y para
    // PayoutsService.hasFreshMfa (misma ventana, sin double-source). Kafka reusa los brokers del servicio
    // (groupId aislado `payment-service-policy`); su REST interno apunta a identity-service firmando
    // admin-rail. FAIL-SAFE: identity/Kafka caídos NO tumban el boot — se sirven los DEFAULTS del catálogo.
    PolicyModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): PolicyRuntimeConfig => ({
        serviceName: 'payment-service',
        kafkaBrokers: config.getOrThrow<string>('KAFKA_BROKERS').split(','),
        identityBaseUrl: config.getOrThrow<string>('IDENTITY_INTERNAL_URL'),
        internalSecret: config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
      }),
    }),
    CoreModule,
    PaymentsModule,
    CommissionModule,
    AffiliationsModule,
    WebhooksModule,
    PromotionsModule,
    IncentivesModule,
    PayoutsModule,
    ReconciliationModule,
    AnalyticsModule,
    EventsModule,
    DriverPaymentsModule,
  ],
  controllers: [HealthController, MetricsController, PaymentGrpcController],
  // §10: PAYMENT_GRPC_REPO es el dueño del acceso Prisma del PaymentGrpcController (lector cross-feature).
  providers: [
    readinessProvider,
    { provide: PAYMENT_GRPC_REPO, useClass: PrismaPaymentGrpcRepository },
  ],
})
export class AppModule {}
