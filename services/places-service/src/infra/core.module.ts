/**
 * CoreModule (global) — singletons de infraestructura compartidos por todos los módulos:
 * Prisma (read/write), Redis, el secreto de identidad interna y los guards de auth.
 */
import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { INTERNAL_IDENTITY_SECRET, InternalIdentityGuard, RolesGuard } from '@veo/auth';
import { PrismaService } from './prisma.service';
import { REDIS, redisProvider } from './redis';
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
    RolesGuard,
  ],
  exports: [PrismaService, REDIS, INTERNAL_IDENTITY_SECRET, InternalIdentityGuard, RolesGuard],
})
export class CoreModule {}
