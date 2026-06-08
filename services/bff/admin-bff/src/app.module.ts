import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule, MetricsModule } from '@veo/observability';
import { JwtAuthGuard, RolesGuard, StepUpMfaGuard } from '@veo/auth';
import { validateEnv } from './config/env.schema';
import { InfraModule } from './infra/infra.module';
import { AuthCoreModule } from './auth/auth-core.module';
import { HealthModule } from './common/health.module';
import { RateLimitGuard } from './rate-limit/rate-limit.guard';
import { AuditModule } from './audit/audit.module';
import { RealtimeModule } from './realtime/realtime.module';
import { AuthModule } from './auth/auth.module';
import { OpsModule } from './ops/ops.module';
import { SecurityModule } from './security/security.module';
import { FleetModule } from './fleet/fleet.module';
import { FinanceModule } from './finance/finance.module';
import { MediaModule } from './media/media.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { PricingModule } from './pricing/pricing.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    LoggerModule.forRoot('admin-bff'),
    MetricsModule,
    InfraModule,
    AuthCoreModule,
    AuditModule,
    RealtimeModule,
    HealthModule,
    AuthModule,
    OpsModule,
    SecurityModule,
    FleetModule,
    FinanceModule,
    MediaModule,
    AnalyticsModule,
    PricingModule,
  ],
  providers: [
    // Orden de guards globales: Jwt (adjunta user) → RateLimit → Roles → StepUpMfa.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: StepUpMfaGuard },
  ],
})
export class AppModule {}
