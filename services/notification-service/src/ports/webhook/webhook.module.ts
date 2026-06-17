import { Module, Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { signHmac, ExternalServiceError } from '@veo/utils';
import { WEBHOOK_SENDER, type WebhookMessage, type WebhookSender } from './webhook.port';
import type { Env } from '../../config/env.schema';

/** Sandbox: imprime el webhook (determinista) en consola. */
export class WebhookSandboxSender implements WebhookSender {
  private readonly logger = new Logger('WebhookSandbox');
  async send(msg: WebhookMessage): Promise<void> {
    this.logger.warn(`[SANDBOX WEBHOOK] → ${msg.url}: ${JSON.stringify(msg.payload)}`);
  }
}

/** Live: POST firmado con HMAC-SHA256 sobre el cuerpo exacto + timestamp (anti-replay). */
export class WebhookHttpSender implements WebhookSender {
  constructor(
    private readonly secret: string,
    private readonly timeoutMs: number,
  ) {}

  async send(msg: WebhookMessage): Promise<void> {
    const timestamp = Date.now().toString();
    const body = JSON.stringify(msg.payload);
    const signature = signHmac(`${timestamp}.${body}`, this.secret);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(msg.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VEO-Timestamp': timestamp,
          'X-VEO-Signature': signature,
        },
        body,
        signal: controller.signal,
      });
      if (!res.ok) throw new ExternalServiceError(`Webhook ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof ExternalServiceError) throw err;
      throw new ExternalServiceError(
        `Webhook: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

const webhookProvider: Provider = {
  provide: WEBHOOK_SENDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): WebhookSender =>
    config.getOrThrow<string>('VEO_WEBHOOK_MODE') === 'live'
      ? new WebhookHttpSender(
          config.getOrThrow<string>('WEBHOOK_SIGNING_SECRET'),
          config.getOrThrow<number>('WEBHOOK_TIMEOUT_MS'),
        )
      : new WebhookSandboxSender(),
};

@Module({ providers: [webhookProvider], exports: [WEBHOOK_SENDER] })
export class WebhookModule {}
