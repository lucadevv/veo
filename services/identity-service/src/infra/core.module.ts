/**
 * CoreModule (global) — singletons de infraestructura compartidos por todos los módulos:
 * Prisma (read/write), Redis, JwtService (ES256), RedisRefreshTokenStore, secreto de identidad interna,
 * y el relay del outbox.
 */
import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  JwtService,
  RedisRefreshTokenStore,
  JWT_SERVICE,
  INTERNAL_IDENTITY_SECRET,
  InternalIdentityGuard,
  RolesGuard,
  StepUpMfaGuard,
  generateDevKeyPairPem,
  type JwtKeys,
} from '@veo/auth';
import { PrismaService } from './prisma.service';
import { REDIS, redisProvider } from './redis';
import { OutboxRelay } from './outbox.relay';
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
  useFactory: async (config: ConfigService<Env, true>) => new JwtService(await resolveJwtKeys(config)),
};

const refreshStoreProvider: Provider = {
  provide: RedisRefreshTokenStore,
  inject: [REDIS, ConfigService],
  useFactory: (redis: Redis, config: ConfigService<Env, true>) =>
    new RedisRefreshTokenStore(redis, config.getOrThrow<number>('REFRESH_TTL_SECONDS')),
};

const internalSecretProvider: Provider = {
  provide: INTERNAL_IDENTITY_SECRET,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
};

@Global()
@Module({
  providers: [
    PrismaService,
    redisProvider,
    jwtProvider,
    { provide: JWT_SERVICE, useExisting: JwtService },
    refreshStoreProvider,
    internalSecretProvider,
    OutboxRelay,
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
    InternalIdentityGuard,
    RolesGuard,
    StepUpMfaGuard,
  ],
})
export class CoreModule {}
