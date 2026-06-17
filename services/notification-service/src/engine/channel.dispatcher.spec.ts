import { describe, it, expect } from 'vitest';
import { NotificationChannel } from '@veo/shared-types';
import { ChannelDispatcher } from './channel.dispatcher';
import type { NotificationRecord, RenderedMessage } from './types';
import type {
  PushMessage,
  PushResult,
  PushSender,
  TokenInvalidator,
} from '../ports/push/push.port';
import type { SmsSender } from '../ports/sms/sms.port';
import type { EmailMessage, EmailSender } from '../ports/email/email.port';
import type { WebhookMessage, WebhookSender } from '../ports/webhook/webhook.port';

class FakePush implements PushSender {
  last?: PushMessage;
  result: PushResult = { outcome: 'accepted' };
  async send(msg: PushMessage): Promise<PushResult> {
    this.last = msg;
    return this.result;
  }
}
class FakeTokens implements TokenInvalidator {
  invalidated: string[] = [];
  async invalidate(token: string): Promise<void> {
    this.invalidated.push(token);
  }
}
class FakeSms implements SmsSender {
  last?: { to: string; message: string };
  async send(to: string, message: string): Promise<void> {
    this.last = { to, message };
  }
}
class FakeEmail implements EmailSender {
  last?: EmailMessage;
  async send(msg: EmailMessage): Promise<void> {
    this.last = msg;
  }
}
class FakeWebhook implements WebhookSender {
  last?: WebhookMessage;
  async send(msg: WebhookMessage): Promise<void> {
    this.last = msg;
  }
}

function record(
  channel: NotificationChannel,
  payload: Record<string, unknown>,
): NotificationRecord {
  return {
    id: 'n1',
    recipientId: 'u1',
    channel,
    template: 't',
    payload,
    status: 'PENDING',
    priority: 0,
    dedupKey: null,
    attempts: 0,
    maxAttempts: 3,
    nextAttemptAt: new Date(),
    sentAt: null,
    deliveredAt: null,
    failedReason: null,
    createdAt: new Date(),
  };
}

function build() {
  const push = new FakePush();
  const tokens = new FakeTokens();
  const sms = new FakeSms();
  const email = new FakeEmail();
  const webhook = new FakeWebhook();
  const dispatcher = new ChannelDispatcher(push, tokens, sms, email, webhook);
  return { push, tokens, sms, email, webhook, dispatcher };
}

const rendered = (over: Partial<RenderedMessage> = {}): RenderedMessage => ({
  to: 'dest',
  body: 'cuerpo',
  ...over,
});

describe('ChannelDispatcher · routing por canal', () => {
  it('PUSH → PushSender con plataforma y data', async () => {
    const { push, sms, email, webhook, dispatcher } = build();
    await dispatcher.dispatch(
      record(NotificationChannel.PUSH, { to: 'tok', platform: 'ios', data: { tripId: 't9' } }),
      rendered({ to: 'tok', subject: 'Título', body: 'msg' }),
    );
    expect(push.last).toEqual({
      target: { kind: 'token', token: 'tok', platform: 'ios' },
      title: 'Título',
      body: 'msg',
      data: { tripId: 't9' },
    });
    expect(sms.last).toBeUndefined();
    expect(email.last).toBeUndefined();
    expect(webhook.last).toBeUndefined();
  });

  it('PUSH con payload.topic → target topic (broadcast), sin token', async () => {
    const { push, dispatcher } = build();
    const result = await dispatcher.dispatch(
      record(NotificationChannel.PUSH, { to: 'promos', topic: 'promos', platform: 'ios' }),
      rendered({ to: 'promos', subject: 'Promo', body: 'msg' }),
    );
    expect(result.status).toBe('sent');
    expect(push.last?.target).toEqual({ kind: 'topic', topic: 'promos' });
  });

  it('SMS → SmsSender(to, body)', async () => {
    const { push, sms, dispatcher } = build();
    await dispatcher.dispatch(
      record(NotificationChannel.SMS, { to: '+51987' }),
      rendered({ to: '+51987', body: 'hola' }),
    );
    expect(sms.last).toEqual({ to: '+51987', message: 'hola' });
    expect(push.last).toBeUndefined();
  });

  it('EMAIL → EmailSender con subject/html', async () => {
    const { email, dispatcher } = build();
    await dispatcher.dispatch(
      record(NotificationChannel.EMAIL, { to: 'a@veo.pe' }),
      rendered({ to: 'a@veo.pe', subject: 'Asunto', body: '<b>hi</b>' }),
    );
    expect(email.last).toEqual({ to: 'a@veo.pe', subject: 'Asunto', html: '<b>hi</b>' });
  });

  it('WEBHOOK → WebhookSender con url=to y payload', async () => {
    const { webhook, dispatcher } = build();
    await dispatcher.dispatch(
      record(NotificationChannel.WEBHOOK, { to: 'https://central/alert', panicId: 'p1' }),
      rendered({ to: 'https://central/alert', body: 'ALERTA' }),
    );
    expect(webhook.last?.url).toBe('https://central/alert');
    expect(webhook.last?.payload).toMatchObject({ panicId: 'p1', body: 'ALERTA' });
  });
});

describe('ChannelDispatcher · resultado tipado del riel PUSH', () => {
  it('accepted → sent (no invalida token)', async () => {
    const { tokens, dispatcher } = build();
    const result = await dispatcher.dispatch(
      record(NotificationChannel.PUSH, { to: 'tok', platform: 'ios' }),
      rendered({ to: 'tok', body: 'x' }),
    );
    expect(result.status).toBe('sent');
    expect(tokens.invalidated).toEqual([]);
  });

  it('invalidToken → invalida el token y devuelve invalidRecipient (feedback loop)', async () => {
    const { push, tokens, dispatcher } = build();
    push.result = { outcome: 'invalidToken', reason: 'UNREGISTERED' };
    const result = await dispatcher.dispatch(
      record(NotificationChannel.PUSH, { to: 'dead-token', platform: 'android' }),
      rendered({ to: 'dead-token', body: 'x' }),
    );
    expect(result.status).toBe('invalidRecipient');
    expect(tokens.invalidated).toEqual(['dead-token']);
  });

  it('rateLimited → propaga retryAfterMs', async () => {
    const { push, dispatcher } = build();
    push.result = { outcome: 'rateLimited', reason: '429', retryAfterMs: 5_000 };
    const result = await dispatcher.dispatch(
      record(NotificationChannel.PUSH, { to: 'tok', platform: 'ios' }),
      rendered({ to: 'tok', body: 'x' }),
    );
    expect(result.status).toBe('rateLimited');
    if (result.status === 'rateLimited') expect(result.retryAfterMs).toBe(5_000);
  });
});
