import { describe, expect, it } from 'vitest';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { SmsModule } from './sms.module';
import { SMS_SENDER, type SmsSender } from './sms.port';
import { NotificationSmsSender } from './notification-sms-sender';
import type { Env } from '../../config/env.schema';

/**
 * Stub mínimo de ConfigService<Env, true>: la factory de SMS solo usa `getOrThrow`. Tipamos el
 * acceso por clave de Env para no usar `any` y mantener el contrato del schema.
 */
function configWith(values: Partial<Env>): ConfigService<Env, true> {
  return {
    getOrThrow: <K extends keyof Env>(key: K): Env[K] => {
      const value = values[key];
      if (value === undefined) throw new Error(`missing env ${String(key)}`);
      return value as Env[K];
    },
  } as unknown as ConfigService<Env, true>;
}

async function resolveSender(config: ConfigService<Env, true>): Promise<SmsSender> {
  // SmsModule no importa ConfigModule (lo provee el AppModule global en runtime). Replicamos esa
  // forma con un módulo @Global que exporta el ConfigService stub, así SmsModule lo resuelve por DI.
  @Global()
  @Module({
    providers: [{ provide: ConfigService, useValue: config }],
    exports: [ConfigService],
  })
  class StubConfigModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [StubConfigModule, SmsModule],
  }).compile();
  return moduleRef.get<SmsSender>(SMS_SENDER);
}

describe('SmsModule factory', () => {
  it('en modo live construye el NotificationSmsSender (delega en notification-service)', async () => {
    const sender = await resolveSender(
      configWith({
        VEO_SMS_MODE: 'live',
        NOTIFICATION_INTERNAL_URL: 'http://notification.local/api/v1',
        INTERNAL_IDENTITY_SECRET: 'test-secret',
        NOTIFICATION_TIMEOUT_MS: 8000,
      }),
    );

    expect(sender).toBeInstanceOf(NotificationSmsSender);
  });

  it('en modo sandbox NO construye el sender live (no toca notification-service)', async () => {
    const sender = await resolveSender(configWith({ VEO_SMS_MODE: 'sandbox' }));

    expect(sender).not.toBeInstanceOf(NotificationSmsSender);
    expect(sender.constructor.name).toBe('SmsSandboxSender');
  });
});
