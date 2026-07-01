/**
 * CoreModule (global) — singletons de infraestructura compartidos por todos los módulos:
 * Prisma (read/write), Redis, JwtService (ES256), RedisRefreshTokenStore, secreto de identidad interna,
 * y el relay del outbox.
 */
import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { CLOCK, SystemClock } from '@veo/utils';
import {
  JwtService,
  RedisRefreshTokenStore,
  SessionRevocationStore,
  JWT_SERVICE,
  INTERNAL_IDENTITY_SECRET,
  INTERNAL_IDENTITY_ALLOWED_AUDIENCES,
  INTERNAL_AUDIENCES,
  InternalIdentityGuard,
  RolesGuard,
  StepUpMfaGuard,
  generateDevKeyPairPem,
  type JwtKeys,
  type InternalAudience,
} from '@veo/auth';
import { createLogger } from '@veo/observability';
import { PrismaService } from './prisma.service';
import { REDIS, redisProvider } from './redis';
import { outboxRelayProvider } from './outbox.relay';
import type { Env } from '../config/env.schema';

async function resolveJwtKeys(config: ConfigService<Env, true>): Promise<JwtKeys> {
  let privatePem = config.get<string>('JWT_PRIVATE_KEY_PEM');
  let publicPem = config.get<string>('JWT_PUBLIC_KEY_PEM');
  if (!privatePem || !publicPem) {
    if (config.getOrThrow<string>('NODE_ENV') === 'production') {
      throw new Error('JWT_PRIVATE_KEY_PEM / JWT_PUBLIC_KEY_PEM son obligatorios en producción');
    }
    const generated = await generateDevKeyPairPem();
    privatePem = generated.privatePem;
    publicPem = generated.publicPem;
  }
  return {
    privatePem,
    publicPem,
    issuer: config.getOrThrow<string>('JWT_ISSUER'),
    audience: config.getOrThrow<string>('JWT_AUDIENCE'),
    accessTtl: config.getOrThrow<string>('JWT_ACCESS_TTL'),
    refreshTtl: config.getOrThrow<string>('JWT_REFRESH_TTL'),
  };
}

const jwtProvider: Provider = {
  provide: JwtService,
  inject: [ConfigService],
  useFactory: async (config: ConfigService<Env, true>) =>
    new JwtService(await resolveJwtKeys(config)),
};

/**
 * Denylist de revocación (enforcement server-side del access token stateless). identity ESCRIBE acá cuando
 * revoca (single-session del conductor, logout, suspensión); los BFFs LEEN en el camino de auth. Comparte
 * el MISMO Redis que el refresh-store → cross-instancia por diseño.
 */
const sessionRevocationProvider: Provider = {
  provide: SessionRevocationStore,
  inject: [REDIS],
  useFactory: (redis: Redis) =>
    new SessionRevocationStore(redis, createLogger('session-revocation')),
};

const refreshStoreProvider: Provider = {
  provide: RedisRefreshTokenStore,
  inject: [REDIS, ConfigService, SessionRevocationStore],
  useFactory: (
    redis: Redis,
    config: ConfigService<Env, true>,
    revocation: SessionRevocationStore,
  ) =>
    new RedisRefreshTokenStore(
      redis,
      config.getOrThrow<number>('REFRESH_TTL_SECONDS'),
      revocation,
    ),
};

const internalSecretProvider: Provider = {
  provide: INTERNAL_IDENTITY_SECRET,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
};

/**
 * Base de MEMBRESÍA del HMAC para `InternalIdentityGuard` (HTTP) — ya NO es la fuente de AUTORIZACIÓN por
 * riel. Antes este set global dejaba que cualquiera de los 4 rieles entrara a cualquier endpoint
 * (confused-deputy H7). Ahora la AUTORIZACIÓN por-endpoint la hace `@Audiences(...)` + `AudienceGuard`
 * (fail-closed, por handler) y el gRPC scopea por-método (`GRPC_METHOD_AUDIENCES`). Este token se conserva
 * SOLO porque `InternalIdentityGuard` exige una lista para validar que el `aud` firmado sea un riel CONOCIDO
 * (que la firma porte una audiencia válida del set cerrado); el QUÉ-puede-pedir-QUÉ vive en @Audiences.
 * Se usa la constante tipada `INTERNAL_AUDIENCES` (fuente única) en vez de literales sueltos.
 */
const ALLOWED_AUDIENCES: readonly InternalAudience[] = INTERNAL_AUDIENCES;

@Global()
@Module({
  providers: [
    PrismaService,
    redisProvider,
    jwtProvider,
    { provide: JWT_SERVICE, useExisting: JwtService },
    sessionRevocationProvider,
    refreshStoreProvider,
    internalSecretProvider,
    { provide: INTERNAL_IDENTITY_ALLOWED_AUDIENCES, useValue: ALLOWED_AUDIENCES },
    outboxRelayProvider,
    { provide: CLOCK, useValue: new SystemClock() },
    InternalIdentityGuard,
    RolesGuard,
    StepUpMfaGuard,
  ],
  exports: [
    PrismaService,
    REDIS,
    JwtService,
    JWT_SERVICE,
    RedisRefreshTokenStore,
    INTERNAL_IDENTITY_SECRET,
    INTERNAL_IDENTITY_ALLOWED_AUDIENCES,
    CLOCK,
    InternalIdentityGuard,
    RolesGuard,
    StepUpMfaGuard,
  ],
})
export class CoreModule {}
