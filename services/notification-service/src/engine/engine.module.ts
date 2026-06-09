/**
 * EngineModule — ensambla el motor PROPIO de notificaciones e inyecta sus dependencias por
 * abstracción (NotificationStore, TemplateRenderer, MessageDispatcher) cumpliendo DIP.
 */
import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PushModule } from '../ports/push/push.module';
import { TOKEN_INVALIDATOR, type TokenInvalidator } from '../ports/push/push.port';
import { SmsModule } from '../ports/sms/sms.module';
import { EmailModule } from '../ports/email/email.module';
import { WebhookModule } from '../ports/webhook/webhook.module';
import { DevicesModule } from '../devices/devices.module';
import { DeviceTokenRepository } from '../devices/device-token.repository';
import { NotificationRepository } from './notification.repository';
import { TemplateService } from './template.service';
import { ChannelDispatcher } from './channel.dispatcher';
import { RetryPolicy } from './retry.policy';
import { NotificationEngine } from './notification.engine';
import { NotificationWorker } from './notification.worker';
import type { Env } from '../config/env.schema';

/** Puerto TokenInvalidator → adaptado al registro de dispositivos (borra el token muerto). DIP. */
const tokenInvalidatorProvider: Provider = {
  provide: TOKEN_INVALIDATOR,
  inject: [DeviceTokenRepository],
  useFactory: (repo: DeviceTokenRepository): TokenInvalidator => ({
    invalidate: (token: string) => repo.deleteByToken(token),
  }),
};

const retryPolicyProvider: Provider = {
  provide: RetryPolicy,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): RetryPolicy =>
    new RetryPolicy({
      baseMs: config.getOrThrow<number>('NOTIFICATION_BACKOFF_BASE_MS'),
      factor: config.getOrThrow<number>('NOTIFICATION_BACKOFF_FACTOR'),
      maxMs: config.getOrThrow<number>('NOTIFICATION_BACKOFF_MAX_MS'),
      defaultMaxAttempts: config.getOrThrow<number>('NOTIFICATION_MAX_ATTEMPTS'),
      jitter: config.getOrThrow<boolean>('NOTIFICATION_RETRY_JITTER'),
    }),
};

const engineProvider: Provider = {
  provide: NotificationEngine,
  inject: [NotificationRepository, TemplateService, ChannelDispatcher, RetryPolicy],
  useFactory: (
    store: NotificationRepository,
    renderer: TemplateService,
    dispatcher: ChannelDispatcher,
    retry: RetryPolicy,
  ): NotificationEngine => new NotificationEngine(store, renderer, dispatcher, retry),
};

@Module({
  imports: [PushModule, SmsModule, EmailModule, WebhookModule, DevicesModule],
  providers: [
    NotificationRepository,
    TemplateService,
    tokenInvalidatorProvider,
    ChannelDispatcher,
    retryPolicyProvider,
    engineProvider,
    NotificationWorker,
  ],
  exports: [NotificationEngine, NotificationRepository, TemplateService],
})
export class EngineModule {}
