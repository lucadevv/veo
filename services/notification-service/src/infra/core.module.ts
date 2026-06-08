/**
 * CoreModule (global) — singletons de infraestructura compartidos: Prisma (read/write), Redis,
 * secreto de identidad interna + InternalIdentityGuard (propagación BFF→servicio) y el relay del outbox.
 */
import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { INTERNAL_IDENTITY_SECRET, InternalIdentityGuard } from '@veo/auth';
import { PrismaService } from './prisma.service';
import { REDIS, redisProvider } from './redis';
import { OutboxRelay } from './outbox.relay';
import type { Env } from '../config/env.schema';

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
    internalSecretProvider,
    InternalIdentityGuard,
    OutboxRelay,
  ],
  exports: [PrismaService, REDIS, INTERNAL_IDENTITY_SECRET, InternalIdentityGuard],
})
export class CoreModule {}
