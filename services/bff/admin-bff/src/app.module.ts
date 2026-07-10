import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule, MetricsModule } from '@veo/observability';
import {
  EXPECTED_SUBJECT_TYPE,
  JwtAuthGuard,
  RolesGuard,
  SessionRevocationGuard,
  StepUpMfaGuard,
  type SubjectType,
} from '@veo/auth';
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
import { CatalogModule } from './catalog/catalog.module';
import { DispatchConfigModule } from './dispatch-config/dispatch-config.module';
import { GobiernoModule } from './gobierno/gobierno.module';

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
    CatalogModule,
    DispatchConfigModule,
    GobiernoModule,
  ],
  providers: [
    // admin-bff SOLO acepta tokens de tipo 'admin' (el JwtAuthGuard rechaza pasajero/conductor aunque
    // la firma/audiencia sean válidas) — no depende solo del RBAC. Defensa en profundidad.
    { provide: EXPECTED_SUBJECT_TYPE, useValue: 'admin' satisfies SubjectType },
    // Orden de guards globales: Jwt (adjunta user) → SessionRevocation → RateLimit → Roles → StepUpMfa.
    // SessionRevocationGuard va JUSTO tras el Jwt (necesita req.user ya poblado) y ANTES del RateLimit:
    // un token revocado (reset anti-takeover del operador, single-session) se rechaza sin consumir cuota
    // de rate-limit ni evaluar RBAC/MFA. Lee el denylist en Redis (enforcement server-side de la
    // revocación, porque el access token es stateless y su firma sigue válida hasta 15m). Idempotente
    // (solo lee) y fail-open ante Redis caído. Respeta @Public vía la ausencia de req.user. Espeja
    // driver-bff (Jwt → DriverType → SessionRevocation).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: SessionRevocationGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: StepUpMfaGuard },
  ],
})
export class AppModule {}
