/**
 * CoreModule (global) — singletons de infraestructura compartidos por todos los módulos:
 * Prisma (read/write), Redis, secreto de identidad interna, guards y el relay del outbox.
 */
import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  InternalIdentityGuard,
  RolesGuard,
  AudienceGuard,
  INTERNAL_IDENTITY_SECRET,
  INTERNAL_IDENTITY_ALLOWED_AUDIENCES,
  InternalAudience,
} from '@veo/auth';
import { InternalRestClient } from '@veo/rpc';
import { PrismaService } from './prisma.service';
import { REDIS, redisProvider } from './redis';
import { outboxRelayProvider } from './outbox.relay';
import { TRIP_REST } from './downstream.tokens';
import type { Env } from '../config/env.schema';

const internalSecretProvider: Provider = {
  provide: INTERNAL_IDENTITY_SECRET,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
};

/**
 * Cliente REST interno firmado hacia trip-service. dispatch hace una llamada SERVICE-TO-SERVICE (sin usuario
 * final) → firma con audiencia `service-rail` (verificada per-service, fail-closed; trip-service la acepta). Lo
 * consume el filtro defensivo de clase operable del pool (seam catálogo↔operabilidad). Espeja el `tripRestProvider`
 * de fleet-service (mismo secreto HMAC compartido, misma audiencia de SISTEMA).
 */
const tripRestProvider: Provider = {
  provide: TRIP_REST,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    new InternalRestClient({
      baseUrl: config.getOrThrow<string>('TRIP_URL'),
      secret: config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
      audience: InternalAudience.SERVICE_RAIL,
      timeoutMs: config.getOrThrow<number>('REST_TIMEOUT_MS'),
    }),
};

const ALLOWED_AUDIENCES: readonly InternalAudience[] = ['public-rail', 'driver-rail', 'admin-rail'];

@Global()
@Module({
  providers: [
    PrismaService,
    redisProvider,
    internalSecretProvider,
    { provide: INTERNAL_IDENTITY_ALLOWED_AUDIENCES, useValue: ALLOWED_AUDIENCES },
    tripRestProvider,
    outboxRelayProvider,
    InternalIdentityGuard,
    RolesGuard,
    AudienceGuard,
  ],
  exports: [
    PrismaService,
    REDIS,
    INTERNAL_IDENTITY_SECRET,
    INTERNAL_IDENTITY_ALLOWED_AUDIENCES,
    TRIP_REST,
    InternalIdentityGuard,
    RolesGuard,
    AudienceGuard,
  ],
})
export class CoreModule {}
