/**
 * CoreModule (global) — singletons de infraestructura: Prisma (read/write), Redis y el secreto
 * de identidad interna + el InternalIdentityGuard (los BFFs propagan la identidad firmada HMAC).
 */
import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { INTERNAL_IDENTITY_SECRET, InternalIdentityGuard } from '@veo/auth';
import { PrismaService } from './prisma.service';
import { REDIS, redisProvider } from './redis';
import { outboxRelayProvider } from './outbox.relay';
import type { Env } from '../config/env.schema';

const internalSecretProvider: Provider = {
  provide: INTERNAL_IDENTITY_SECRET,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    config.getOrThrow<string>('INTERNAL_IDENTITY_SECRET'),
};

@Global()
@Module({
  providers: [PrismaService, redisProvider, internalSecretProvider, InternalIdentityGuard, outboxRelayProvider],
  exports: [PrismaService, REDIS, INTERNAL_IDENTITY_SECRET, InternalIdentityGuard],
})
export class CoreModule {}
