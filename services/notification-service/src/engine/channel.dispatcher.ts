/**
 * ChannelDispatcher — router por canal: traduce el mensaje renderizado a la llamada del puerto
 * correcto y devuelve un `DispatchResult` TIPADO. El mapeo canal→estrategia vive en un REGISTRY (`Map`),
 * no en un `switch`: agregar un canal = registrar una entrada (OCP). Cierra además el feedback loop de
 * tokens muertos en PUSH. Discriminantes por constante (`PushOutcome`/`DispatchStatus`), nunca strings.
 */
import { Inject, Injectable } from '@nestjs/common';
import { NotificationChannel } from '@veo/shared-types';
import { ValidationError } from '@veo/utils';
import {
  PUSH_SENDER,
  PushOutcome,
  PushPlatform,
  PushTargetKind,
  TOKEN_INVALIDATOR,
  type PushMessage,
  type PushSender,
  type PushTarget,
  type TokenInvalidator,
} from '../ports/push/push.port';
import { SMS_SENDER, type SmsSender } from '../ports/sms/sms.port';
import { EMAIL_SENDER, type EmailSender } from '../ports/email/email.port';
import { WEBHOOK_SENDER, type WebhookSender } from '../ports/webhook/webhook.port';
import {
  DispatchStatus,
  type DispatchResult,
  type MessageDispatcher,
  type NotificationRecord,
  type RenderedMessage,
} from './types';

/** Título por defecto cuando la plantilla no define `subject` (constante nombrada, no literal disperso). */
const DEFAULT_TITLE = 'VEO';

/** Estrategia de despacho de un canal: del registro renderizado → resultado tipado del riel. */
type ChannelStrategy = (rec: NotificationRecord, rendered: RenderedMessage) => Promise<DispatchResult>;

function toStringMap(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}

/** Vista TIPADA de los campos de push dentro del payload genérico (`Record<string, unknown>`). */
interface PushPayloadView {
  readonly topic?: string;
  readonly condition?: string;
  readonly platform?: PushPlatform;
  readonly data?: unknown;
}

/**
 * Centraliza el acceso stringly-typed al payload en UN solo lugar (con type-guards), para que el resto
 * trabaje con una vista tipada y un typo en una key no se traduzca en `undefined` silencioso.
 */
function parsePushPayload(payload: Record<string, unknown>): PushPayloadView {
  const view: { -readonly [K in keyof PushPayloadView]: PushPayloadView[K] } = {};
  if (typeof payload.topic === 'string' && payload.topic.length > 0) view.topic = payload.topic;
  if (typeof payload.condition === 'string' && payload.condition.length > 0) view.condition = payload.condition;
  if (payload.platform === PushPlatform.Ios || payload.platform === PushPlatform.Android) {
    view.platform = payload.platform;
  }
  if (payload.data !== undefined) view.data = payload.data;
  return view;
}

@Injectable()
export class ChannelDispatcher implements MessageDispatcher {
  /** Registry canal→estrategia. Reemplaza el switch (OCP): un canal nuevo = una entrada nueva. */
  private readonly strategies: ReadonlyMap<NotificationChannel, ChannelStrategy>;

  constructor(
    @Inject(PUSH_SENDER) private readonly push: PushSender,
    @Inject(TOKEN_INVALIDATOR) private readonly tokens: TokenInvalidator,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(WEBHOOK_SENDER) private readonly webhook: WebhookSender,
  ) {
    this.strategies = new Map<NotificationChannel, ChannelStrategy>([
      [NotificationChannel.PUSH, (rec, rendered) => this.dispatchPush(rec, rendered)],
      [NotificationChannel.SMS, (_rec, rendered) => this.attempt(() => this.sms.send(rendered.to, rendered.body))],
      [
        NotificationChannel.EMAIL,
        (_rec, rendered) =>
          this.attempt(() =>
            this.email.send({ to: rendered.to, subject: rendered.subject ?? DEFAULT_TITLE, html: rendered.body }),
          ),
      ],
      [
        NotificationChannel.WEBHOOK,
        (rec, rendered) =>
          this.attempt(() => this.webhook.send({ url: rendered.to, payload: { ...rec.payload, body: rendered.body } })),
      ],
    ]);
  }

  async dispatch(rec: NotificationRecord, rendered: RenderedMessage): Promise<DispatchResult> {
    const strategy = this.strategies.get(rec.channel);
    if (!strategy) {
      // Canal no soportado = error de programación (enum incompleto), no un resultado de entrega.
      throw new ValidationError(`Canal no soportado: ${String(rec.channel)}`);
    }
    return strategy(rec, rendered);
  }

  /** PUSH: traduce el `PushResult` del riel a `DispatchResult` y CIERRA el loop borrando tokens muertos. */
  private async dispatchPush(rec: NotificationRecord, rendered: RenderedMessage): Promise<DispatchResult> {
    const payload = parsePushPayload(rec.payload);
    const target = this.resolvePushTarget(payload, rendered);
    const data = toStringMap(payload.data);
    const msg: PushMessage = {
      target,
      title: rendered.subject ?? DEFAULT_TITLE,
      body: rendered.body,
      ...(data ? { data } : {}),
    };

    const result = await this.push.send(msg);
    switch (result.outcome) {
      case PushOutcome.Accepted:
        return { status: DispatchStatus.Sent };
      case PushOutcome.InvalidToken:
        // Feedback loop: SOLO un token puede invalidarse (un topic no tiene token). Gate por kind.
        if (target.kind === PushTargetKind.Token) {
          await this.tokens.invalidate(target.token);
        }
        return { status: DispatchStatus.InvalidRecipient, reason: result.reason };
      case PushOutcome.RateLimited:
        return {
          status: DispatchStatus.RateLimited,
          reason: result.reason,
          ...(result.retryAfterMs ? { retryAfterMs: result.retryAfterMs } : {}),
        };
      case PushOutcome.Transient:
        return { status: DispatchStatus.Transient, reason: result.reason };
    }
  }

  /**
   * Resuelve el destino del push desde la vista tipada del payload: por default TOKEN (flujo 1-a-1, usa
   * `rendered.to` + plataforma). Si el payload trae `topic`/`condition`, es un BROADCAST (FCM hace el fanout).
   */
  private resolvePushTarget(payload: PushPayloadView, rendered: RenderedMessage): PushTarget {
    if (payload.topic) {
      return { kind: PushTargetKind.Topic, topic: payload.topic };
    }
    if (payload.condition) {
      return { kind: PushTargetKind.Condition, condition: payload.condition };
    }
    return {
      kind: PushTargetKind.Token,
      token: rendered.to,
      platform: payload.platform ?? PushPlatform.Android,
    };
  }

  /** Canales que aún lanzan por error (SMS/EMAIL/WEBHOOK): envuelve éxito→sent, throw→transient (reintenta). */
  private async attempt(fn: () => Promise<void>): Promise<DispatchResult> {
    try {
      await fn();
      return { status: DispatchStatus.Sent };
    } catch (err) {
      return { status: DispatchStatus.Transient, reason: err instanceof Error ? err.message : String(err) };
    }
  }
}
