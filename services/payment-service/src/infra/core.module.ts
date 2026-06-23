/**
 * CoreModule (global) — singletons de infraestructura compartidos por todos los módulos:
 * Prisma (read/write), Redis, secreto de identidad interna, guards de auth/RBAC/step-up,
 * y el relay del outbox.
 */
import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  INTERNAL_IDENTITY_SECRET,
  INTERNAL_IDENTITY_ALLOWED_AUDIENCES,
  INTERNAL_AUDIENCES,
  InternalIdentityGuard,
  AudienceGuard,
  RolesGuard,
  StepUpMfaGuard,
  type InternalAudience,
} from '@veo/auth';
import { CLOCK, SystemClock } from '@veo/utils';
import { PrismaService } from './prisma.service';
import { REDIS, redisProvider } from './redis';
import { outboxRelayProvider } from './outbox.relay';
import { PaymentMetrics } from '../metrics/payment.metrics';
import type { Env } from '../config/env.schema';

const internalSecretProvider: Provider = {
  provide: INTERNAL_IDENTITY_SECRET,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
};

/**
 * Base de MEMBRESÍA del HMAC para `InternalIdentityGuard` (HTTP) — ya NO es la fuente de AUTORIZACIÓN por
 * riel. Antes era el set GLOBAL `[public, driver, admin]` (sin service-rail): dejaba que esos rieles entraran
 * a CUALQUIER endpoint y cerraba la puerta a los servicios internos. F3a (ADR-014 §5.5) lo pasa a la fuente
 * única `INTERNAL_AUDIENCES` (los 4 rieles CONOCIDOS, incluido service-rail) y delega el QUÉ-puede-pedir-QUÉ a
 * `@Audiences(...)` + `AudienceGuard` (fail-closed, por handler) en HTTP y a `GRPC_METHOD_AUDIENCES` per-RPC en
 * gRPC. Este token solo le dice al guard cuáles `aud` firmados son un riel VÁLIDO del set cerrado; la
 * autorización per-endpoint vive en @Audiences. Espeja identity-service y booking-service.
 */
const ALLOWED_AUDIENCES: readonly InternalAudience[] = INTERNAL_AUDIENCES;

@Global()
@Module({
  providers: [
    PrismaService,
    redisProvider,
    internalSecretProvider,
    { provide: INTERNAL_IDENTITY_ALLOWED_AUDIENCES, useValue: ALLOWED_AUDIENCES },
    outboxRelayProvider,
    { provide: CLOCK, useValue: new SystemClock() },
    PaymentMetrics,
    InternalIdentityGuard,
    AudienceGuard,
    RolesGuard,
    StepUpMfaGuard,
  ],
  exports: [
    PrismaService,
    REDIS,
    INTERNAL_IDENTITY_SECRET,
    INTERNAL_IDENTITY_ALLOWED_AUDIENCES,
    CLOCK,
    PaymentMetrics,
    InternalIdentityGuard,
    AudienceGuard,
    RolesGuard,
    StepUpMfaGuard,
  ],
})
export class CoreModule {}
