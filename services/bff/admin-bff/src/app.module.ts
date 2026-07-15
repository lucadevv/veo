import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule, MetricsModule } from '@veo/observability';
import {
  EXPECTED_SUBJECT_TYPE,
  InternalAudience,
  JwtAuthGuard,
  RolesGuard,
  SessionRevocationGuard,
  StepUpMfaGuard,
  type SubjectType,
} from '@veo/auth';
import { PolicyModule } from '@veo/policy/nest';
import { validateEnv, type Env } from './config/env.schema';
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
import { IpAllowlistGuard } from './policies/ip-allowlist.guard';
import { SessionIdleGuard } from './policies/session-idle.guard';
import { PolicyStepUpMfaGuard } from './policies/policy-step-up-mfa.guard';
import { PermissionOverlayGuard } from './policies/permission-overlay.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv }),
    LoggerModule.forRoot('admin-bff'),
    MetricsModule,
    InfraModule,
    // PBAC (ADR-024 Fase 1 · Ola B): cliente runtime de políticas. Provee `POLICY_READER_PORT` (que el
    // StepUpMfaGuard global lee, @Optional) con la ventana `auth.stepup.maxAgeSec` VIGENTE — un cambio del
    // superadmin surte efecto sin redeploy. Frescura por Kafka (`policy.updated`): el admin-bff YA es
    // consumer Kafka (KafkaConsumerService del read-model CQRS + realtime), así que esto NO monta infra
    // nueva — reusa los MISMOS brokers. Carga inicial fail-safe vía REST interno firmado (admin-rail) a
    // identity `/internal/policies`, reusando IDENTITY_URL + el secreto HMAC del InfraModule. groupId propio
    // (`admin-bff-policy`) para aislar sus offsets/rebalances del consumer de dominio. Si Kafka/identity no
    // responden al boot, el reader degrada al DEFAULT endurecido (el guard sigue con 300s · fail-safe).
    PolicyModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        serviceName: 'admin-bff',
        kafkaBrokers: config
          .get('KAFKA_BROKERS', { infer: true })
          .split(',')
          .map((b) => b.trim()),
        identityBaseUrl: String(config.get('IDENTITY_URL', { infer: true })),
        internalSecret: config.get('VEO_INTERNAL_IDENTITY_SECRET', { infer: true }),
        audience: InternalAudience.ADMIN_RAIL,
      }),
    }),
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
    // Orden de guards globales: Jwt (adjunta user) → SessionRevocation → RateLimit → Roles →
    // PermissionOverlay → StepUpMfa.
    // SessionRevocationGuard va JUSTO tras el Jwt (necesita req.user ya poblado) y ANTES del RateLimit:
    // un token revocado (reset anti-takeover del operador, single-session) se rechaza sin consumir cuota
    // de rate-limit ni evaluar RBAC/MFA. Lee el denylist en Redis (enforcement server-side de la
    // revocación, porque el access token es stateless y su firma sigue válida hasta 15m). Idempotente
    // (solo lee) y fail-open ante Redis caído. Respeta @Public vía la ausencia de req.user. Espeja
    // driver-bff (Jwt → DriverType → SessionRevocation).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: SessionRevocationGuard },
    // PBAC Fase 2 (ADR-024 §5 · NET-NEW). Corren tras el Jwt (necesitan req.user) y ANTES del RateLimit/RBAC:
    //  • IpAllowlistGuard  — `access.ip-allowlist`: corta una IP no autorizada temprano (antes de gastar cuota).
    //  • SessionIdleGuard  — `auth.session-timeout`: idle tracking en Redis, complementa el TTL duro del token.
    // Ambas arrancan DISABLED por default (NET-NEW) → fail-safe: sin cambio del superadmin, no restringen nada.
    { provide: APP_GUARD, useClass: IpAllowlistGuard },
    { provide: APP_GUARD, useClass: SessionIdleGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // OVERLAY de visibilidad (ADR-025 §3/§6/§7 · Fase 1 · Ola A). Corre JUSTO tras el RolesGuard: el @Roles
    // base ya validó la CAPA 1 (qué rol puede); este guard REFINA restando (subtract-only), computando el
    // EFECTIVO `base ∧ ¬override` por PERMISO para los handlers marcados con @Permission. NO-OP hasta que el
    // barrido endpoint→permiso (Ola B) declare @Permission: sin permiso mapeado no hay overlay que aplicar,
    // así que hoy NO cambia comportamiento. Fail-safe: reader ausente/cache frío → base pura (nunca bloquea
    // por un fallo de lectura, nunca concede de más).
    { provide: APP_GUARD, useClass: PermissionOverlayGuard },
    { provide: APP_GUARD, useClass: StepUpMfaGuard },
    // PBAC Fase 2 · `pii.reveal-stepup`: step-up MFA policy-aware (ventana propia) para handlers marcados con
    // @RequireStepUpMfaForPolicy. No-op salvo en el detalle de conductor que revela el DNI. DISABLED por default.
    { provide: APP_GUARD, useClass: PolicyStepUpMfaGuard },
  ],
})
export class AppModule {}
