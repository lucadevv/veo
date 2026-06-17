/**
 * NotificationEngine — núcleo del motor PROPIO (sin mocks): encolado con dedup, renderizado de
 * plantilla, routing por canal y reintentos exponenciales hasta maxAttempts.
 *  - Éxito → markDelivered (publica notification.delivered por outbox).
 *  - Fallo recuperable → scheduleRetry (backoff).
 *  - Agotado → markFailed (publica notification.failed por outbox).
 */
import { Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from '@veo/utils';
import { RetryPolicy } from './retry.policy';
import {
  DispatchStatus,
  NotificationPriority,
  type DeliveryOutcome,
  type EnqueueInput,
  type EnqueueResult,
  type MessageDispatcher,
  type NotificationRecord,
  type NotificationStore,
  type RenderedMessage,
  type TemplateRenderer,
} from './types';
import {
  bumpNotificationFailed,
  NotificationFailureKind,
  priorityLabel,
} from '../metrics/notification.metrics';

@Injectable()
export class NotificationEngine {
  private readonly logger = new Logger(NotificationEngine.name);

  constructor(
    private readonly store: NotificationStore,
    private readonly renderer: TemplateRenderer,
    private readonly dispatcher: MessageDispatcher,
    private readonly retry: RetryPolicy,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Encola una notificación. Si la dedupKey ya existe, NO se reenvía (devuelve la existente). */
  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    if (input.dedupKey) {
      const existing = await this.store.findByDedupKey(input.dedupKey);
      if (existing) {
        this.logger.debug(`dedup: ${input.dedupKey} ya encolada (${existing.id})`);
        return { notification: existing, deduped: true };
      }
    }
    try {
      const notification = await this.store.create({
        id: uuidv7(),
        recipientId: input.recipientId,
        channel: input.channel,
        template: input.template,
        payload: input.payload,
        priority: input.priority ?? NotificationPriority.Normal,
        dedupKey: input.dedupKey ?? null,
        maxAttempts: input.maxAttempts ?? this.retry.defaultMaxAttempts,
        nextAttemptAt: this.now(),
      });
      return { notification, deduped: false };
    } catch (err) {
      // CARRERA: el `findByDedupKey` y el `create` NO son atómicos. Si OTRA réplica del consumer insertó
      // la misma dedupKey en el medio, el constraint @unique hace fallar este `create`. Re-consultamos: si
      // ahora existe, fue justamente ese dedup (devolvemos la existente, no relanzamos → no reprocesa el
      // batch Kafka en loop). Si el fallo NO era por la dedupKey, no hay existente → relanzamos. Store-agnóstico.
      if (input.dedupKey) {
        const raced = await this.store.findByDedupKey(input.dedupKey);
        if (raced) {
          this.logger.debug(
            `dedup (carrera): ${input.dedupKey} insertada por otra réplica (${raced.id})`,
          );
          return { notification: raced, deduped: true };
        }
      }
      throw err;
    }
  }

  /** Procesa un intento de entrega: render → dispatch tipado → decide estado (honesto) + retry. */
  async process(rec: NotificationRecord): Promise<DeliveryOutcome> {
    const attempts = rec.attempts + 1;

    let rendered: RenderedMessage;
    try {
      rendered = await this.renderer.render(rec);
    } catch (err) {
      // Error de render (p. ej. plantilla ausente / blip de DB): transitorio → retry/fail por agotamiento.
      return this.retryOrFail(rec, attempts, err instanceof Error ? err.message : String(err));
    }

    const result = await this.dispatcher.dispatch(rec, rendered);
    switch (result.status) {
      case DispatchStatus.Sent:
        // Honesto: el riel ACEPTÓ (SENT), no "entregado al device".
        await this.store.markSent(rec.id, { to: rendered.to, channel: rec.channel, attempts });
        return { status: 'SENT', attempts };
      case DispatchStatus.InvalidRecipient:
        // Permanente: destino muerto (el dispatcher ya invalidó el token). NO se reintenta.
        await this.store.markFailed(rec.id, {
          channel: rec.channel,
          reason: result.reason,
          attempts,
        });
        this.logger.warn(`notificación ${rec.id} FAILED (destino inválido): ${result.reason}`);
        bumpNotificationFailed({
          channel: rec.channel,
          kind: NotificationFailureKind.InvalidRecipient,
          priority: priorityLabel(rec.priority),
        });
        return { status: 'FAILED', attempts, reason: result.reason };
      case DispatchStatus.RateLimited:
        return this.retryOrFail(rec, attempts, result.reason, result.retryAfterMs);
      case DispatchStatus.Transient:
        return this.retryOrFail(rec, attempts, result.reason);
    }
  }

  /** Reprograma con backoff (respeta `retryAfterMs` del riel si lo informó) o marca FAILED al agotar. */
  private async retryOrFail(
    rec: NotificationRecord,
    attempts: number,
    reason: string,
    retryAfterMs?: number,
  ): Promise<DeliveryOutcome> {
    if (this.retry.isExhausted(attempts, rec.maxAttempts)) {
      await this.store.markFailed(rec.id, { channel: rec.channel, reason, attempts });
      this.logger.warn(`notificación ${rec.id} FAILED tras ${attempts} intentos: ${reason}`);
      bumpNotificationFailed({
        channel: rec.channel,
        kind: NotificationFailureKind.RetryExhausted,
        priority: priorityLabel(rec.priority),
      });
      return { status: 'FAILED', attempts, reason };
    }
    const baseDelay = this.retry.nextDelayMs(attempts);
    const delay = retryAfterMs && retryAfterMs > baseDelay ? retryAfterMs : baseDelay;
    const nextAttemptAt = new Date(this.now().getTime() + delay);
    await this.store.scheduleRetry(rec.id, { attempts, nextAttemptAt, reason });
    return { status: 'RETRY', attempts, reason, nextAttemptAt };
  }

  /** Drena las notificaciones vencidas (PENDING con nextAttemptAt <= now) y las procesa. */
  async drainDue(limit: number): Promise<number> {
    const due = await this.store.findDue(this.now(), limit);
    for (const rec of due) {
      await this.process(rec);
    }
    return due.length;
  }
}
