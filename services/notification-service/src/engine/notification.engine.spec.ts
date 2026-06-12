import { describe, it, expect } from 'vitest';
import { NotificationChannel } from '@veo/shared-types';
import { NotificationEngine } from './notification.engine';
import { NotificationPriority } from './types';
import { RetryPolicy } from './retry.policy';
import type {
  CreateNotificationInput,
  DispatchResult,
  MessageDispatcher,
  NotificationRecord,
  NotificationStore,
  TemplateRenderer,
} from './types';

/** Store en memoria (doble determinista, sin Prisma) para testear el motor puro. */
class InMemoryStore implements NotificationStore {
  readonly records = new Map<string, NotificationRecord>();
  private readonly dedup = new Map<string, string>();

  async findByDedupKey(dedupKey: string): Promise<NotificationRecord | null> {
    const id = this.dedup.get(dedupKey);
    return id ? (this.records.get(id) ?? null) : null;
  }
  async create(input: CreateNotificationInput): Promise<NotificationRecord> {
    const rec: NotificationRecord = {
      ...input,
      status: 'PENDING',
      attempts: 0,
      sentAt: null,
      deliveredAt: null,
      failedReason: null,
      createdAt: new Date(),
    };
    this.records.set(rec.id, rec);
    if (rec.dedupKey) this.dedup.set(rec.dedupKey, rec.id);
    return rec;
  }
  async findById(id: string): Promise<NotificationRecord | null> {
    return this.records.get(id) ?? null;
  }
  async findByRecipient(recipientId: string, limit: number): Promise<NotificationRecord[]> {
    return [...this.records.values()].filter((r) => r.recipientId === recipientId).slice(0, limit);
  }
  async findInboxByRecipient(recipientId: string, limit: number): Promise<NotificationRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.recipientId === recipientId && r.channel === 'PUSH')
      .slice(0, limit);
  }
  async findDue(now: Date, limit: number): Promise<NotificationRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.status === 'PENDING' && r.nextAttemptAt !== null && r.nextAttemptAt <= now)
      // Igual que el repo real: prioridad DESC primero, luego FIFO por nextAttemptAt.
      .sort((a, b) => b.priority - a.priority || a.nextAttemptAt!.getTime() - b.nextAttemptAt!.getTime())
      .slice(0, limit);
  }
  async markSent(id: string, args: { attempts: number }): Promise<void> {
    const r = this.records.get(id);
    if (!r) return;
    // Honesto: SENT = riel aceptó. deliveredAt queda NULL (no hay receipt real).
    r.status = 'SENT';
    r.attempts = args.attempts;
    r.sentAt = new Date();
    r.nextAttemptAt = null;
  }
  async markFailed(id: string, args: { reason: string; attempts: number }): Promise<void> {
    const r = this.records.get(id);
    if (!r) return;
    r.status = 'FAILED';
    r.attempts = args.attempts;
    r.failedReason = args.reason;
    r.nextAttemptAt = null;
  }
  async scheduleRetry(
    id: string,
    args: { attempts: number; nextAttemptAt: Date; reason: string },
  ): Promise<void> {
    const r = this.records.get(id);
    if (!r) return;
    r.attempts = args.attempts;
    r.nextAttemptAt = args.nextAttemptAt;
    r.failedReason = args.reason;
  }
}

const renderer: TemplateRenderer = {
  async render(rec) {
    return { to: String(rec.payload.to ?? 'dest'), body: 'cuerpo' };
  },
};

/** Dispatcher que devuelve `transient` las primeras N veces y luego `sent` (contrato no-throw). */
class FlakyDispatcher implements MessageDispatcher {
  public calls = 0;
  constructor(private readonly failTimes: number) {}
  async dispatch(): Promise<DispatchResult> {
    this.calls += 1;
    if (this.calls <= this.failTimes) return { status: 'transient', reason: `fallo simulado #${this.calls}` };
    return { status: 'sent' };
  }
}

const FIXED_NOW = new Date('2026-05-28T23:00:00.000Z');
const policy = new RetryPolicy({
  baseMs: 1_000,
  factor: 2,
  maxMs: 60_000,
  defaultMaxAttempts: 5,
  jitter: false,
});

function build(dispatcher: MessageDispatcher) {
  const store = new InMemoryStore();
  const engine = new NotificationEngine(store, renderer, dispatcher, policy, () => FIXED_NOW);
  return { store, engine };
}

describe('NotificationEngine · dedup', () => {
  it('no reenvía una notificación con la misma dedupKey', async () => {
    const { store, engine } = build(new FlakyDispatcher(0));
    const first = await engine.enqueue({
      recipientId: 'u1',
      channel: NotificationChannel.SMS,
      template: 'contact.otp',
      payload: { to: '+51987654321' },
      dedupKey: 'otp:u1:abc',
    });
    const second = await engine.enqueue({
      recipientId: 'u1',
      channel: NotificationChannel.SMS,
      template: 'contact.otp',
      payload: { to: '+51987654321' },
      dedupKey: 'otp:u1:abc',
    });
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.notification.id).toBe(first.notification.id);
    expect(store.records.size).toBe(1);
  });

  it('sin dedupKey crea filas independientes', async () => {
    const { store, engine } = build(new FlakyDispatcher(0));
    await engine.enqueue({ recipientId: 'u1', channel: NotificationChannel.SMS, template: 't', payload: { to: 'a' } });
    await engine.enqueue({ recipientId: 'u1', channel: NotificationChannel.SMS, template: 't', payload: { to: 'a' } });
    expect(store.records.size).toBe(2);
  });
});

describe('NotificationEngine · dedup en carrera (insert concurrente)', () => {
  it('si el create choca por unique (otra réplica insertó la dedupKey), devuelve la existente sin relanzar', async () => {
    const store = new InMemoryStore();
    const engine = new NotificationEngine(store, renderer, new FlakyDispatcher(0), policy, () => FIXED_NOW);
    // Simula la carrera: el primer findByDedupKey ve null, pero entre eso y el create OTRA réplica inserta
    // la misma dedupKey → este create choca con el @unique.
    const original = store.create.bind(store);
    let raced = false;
    store.create = async (input) => {
      if (!raced && input.dedupKey) {
        raced = true;
        await original({ ...input, id: 'other-replica' }); // la otra réplica gana
        throw new Error('Unique constraint failed (P2002)'); // y este create choca
      }
      return original(input);
    };
    const result = await engine.enqueue({
      recipientId: 'u1',
      channel: NotificationChannel.SMS,
      template: 't',
      payload: { to: '+51999' },
      dedupKey: 'race:u1:xyz',
    });
    expect(result.deduped).toBe(true);
    expect(result.notification.id).toBe('other-replica');
    expect(store.records.size).toBe(1); // NO duplica
  });

  it('si el create falla por OTRA razón (sin dedup existente), relanza', async () => {
    const store = new InMemoryStore();
    const engine = new NotificationEngine(store, renderer, new FlakyDispatcher(0), policy, () => FIXED_NOW);
    store.create = async () => {
      throw new Error('db caída');
    };
    await expect(
      engine.enqueue({
        recipientId: 'u1',
        channel: NotificationChannel.SMS,
        template: 't',
        payload: { to: 'x' },
        dedupKey: 'k',
      }),
    ).rejects.toThrow('db caída');
  });
});

describe('NotificationEngine · retry/backoff', () => {
  it('reprograma con backoff exponencial tras un fallo', async () => {
    const { store, engine } = build(new FlakyDispatcher(1));
    const { notification } = await engine.enqueue({
      recipientId: 'u1',
      channel: NotificationChannel.SMS,
      template: 't',
      payload: { to: '+51999' },
    });
    const outcome = await engine.process(notification);
    expect(outcome.status).toBe('RETRY');
    if (outcome.status === 'RETRY') {
      expect(outcome.attempts).toBe(1);
      // base * factor^(1-1) = 1000ms
      expect(outcome.nextAttemptAt.getTime()).toBe(FIXED_NOW.getTime() + 1_000);
    }
    expect(store.records.get(notification.id)?.status).toBe('PENDING');
  });

  it('reintenta hasta entregar', async () => {
    const { store, engine } = build(new FlakyDispatcher(1));
    const { notification } = await engine.enqueue({
      recipientId: 'u1',
      channel: NotificationChannel.SMS,
      template: 't',
      payload: { to: '+51999' },
    });
    await engine.process(notification); // 1º falla → RETRY
    const due = await store.findDue(new Date(FIXED_NOW.getTime() + 5_000), 10);
    const ok = await engine.process(due[0]!); // 2º el riel acepta
    expect(ok.status).toBe('SENT');
    expect(ok.attempts).toBe(2);
    expect(store.records.get(notification.id)?.status).toBe('SENT');
  });

  it('marca FAILED al agotar maxAttempts', async () => {
    const { store, engine } = build(new FlakyDispatcher(99));
    const { notification } = await engine.enqueue({
      recipientId: 'u1',
      channel: NotificationChannel.SMS,
      template: 't',
      payload: { to: '+51999' },
      maxAttempts: 2,
    });
    const r1 = await engine.process(notification);
    expect(r1.status).toBe('RETRY');
    const reloaded = store.records.get(notification.id)!;
    const r2 = await engine.process(reloaded);
    expect(r2.status).toBe('FAILED');
    if (r2.status === 'FAILED') expect(r2.attempts).toBe(2);
    expect(store.records.get(notification.id)?.status).toBe('FAILED');
    expect(store.records.get(notification.id)?.failedReason).toContain('fallo simulado');
  });

  it('entrega al primer intento cuando el canal responde', async () => {
    const { store, engine } = build(new FlakyDispatcher(0));
    const { notification } = await engine.enqueue({
      recipientId: 'u1',
      channel: NotificationChannel.SMS,
      template: 't',
      payload: { to: '+51999' },
    });
    const outcome = await engine.process(notification);
    expect(outcome.status).toBe('SENT');
    expect(outcome.attempts).toBe(1);
    // Honesto: SENT marca sentAt; deliveredAt queda NULL (sin receipt real).
    expect(store.records.get(notification.id)?.sentAt).not.toBeNull();
    expect(store.records.get(notification.id)?.deliveredAt).toBeNull();
  });
});

describe('NotificationEngine · prioridad (SAFETY: pánico antes que broadcast)', () => {
  it('el Critical (pánico) drena ANTES que el Bulk (broadcast) aunque el Bulk se encoló primero', async () => {
    const { store, engine } = build(new FlakyDispatcher(0));
    // Broadcast (Bulk) encolado PRIMERO…
    await engine.enqueue({
      recipientId: 'all',
      channel: NotificationChannel.PUSH,
      template: 't',
      payload: { to: 'x' },
      priority: NotificationPriority.Bulk,
    });
    // …y un pánico (Critical) DESPUÉS.
    await engine.enqueue({
      recipientId: 'u1',
      channel: NotificationChannel.SMS,
      template: 't',
      payload: { to: '+51' },
      priority: NotificationPriority.Critical,
    });
    const due = await store.findDue(new Date(FIXED_NOW.getTime() + 1), 10);
    // El pánico va PRIMERO pese a haberse encolado último (orderBy priority desc).
    expect(due[0]?.priority).toBe(NotificationPriority.Critical);
    expect(due[1]?.priority).toBe(NotificationPriority.Bulk);
  });

  it('sin priority explícita = Normal (default)', async () => {
    const { store, engine } = build(new FlakyDispatcher(0));
    const { notification } = await engine.enqueue({
      recipientId: 'u1',
      channel: NotificationChannel.SMS,
      template: 't',
      payload: { to: 'a' },
    });
    expect(store.records.get(notification.id)?.priority).toBe(NotificationPriority.Normal);
  });
});

/**
 * REGRESIÓN del bug de durabilidad del SMS de pánico (fix B1). Antes, share-service mandaba el SMS
 * INLINE: si el proveedor fallaba, el catch lo tragaba y Kafka ACKeaba → el SMS se perdía PARA SIEMPRE
 * (en redelivery el enlace deduped lo omitía). Ahora el fan-out es DURABLE en el engine: un fallo
 * transitorio del proveedor reprograma con backoff y el SMS TERMINA enviado.
 */
describe('NotificationEngine · pánico durable (REGRESIÓN del SMS perdido)', () => {
  it('SMS de pánico: el proveedor falla el 1er intento, éxito el 2do → el SMS TERMINA enviado', async () => {
    const dispatcher = new FlakyDispatcher(1); // falla 1 vez, luego acepta
    const { store, engine } = build(dispatcher);

    const { notification } = await engine.enqueue({
      recipientId: 'pax-1',
      channel: NotificationChannel.SMS,
      template: 'panic.contact_alert',
      priority: NotificationPriority.Critical,
      // dedupKey por contactId (NO por teléfono): idempotente y sin PII.
      dedupKey: 'panic:pn1:sms:contact-1',
      payload: { to: '+51987654321', vars: { name: 'Ana', shareLink: 'https://veo.pe/s/x', lat: -12, lon: -77 } },
    });

    // 1er intento: el proveedor falla → en el modelo viejo el SMS se PERDÍA acá.
    const first = await engine.process(notification);
    expect(first.status).toBe('RETRY');
    expect(store.records.get(notification.id)?.status).toBe('PENDING'); // sigue vivo, reprogramado

    // El worker lo vuelve a tomar cuando vence el backoff…
    const due = await store.findDue(new Date(FIXED_NOW.getTime() + 5_000), 10);
    const second = await engine.process(due[0]!);

    // …y el 2do intento ENTREGA. El SMS de pánico NO se pierde.
    expect(second.status).toBe('SENT');
    expect(second.attempts).toBe(2);
    expect(store.records.get(notification.id)?.status).toBe('SENT');
    expect(dispatcher.calls).toBe(2);
  });

  it('reintenta hasta agotar y persiste con backoff acumulado sin perder el registro', async () => {
    const dispatcher = new FlakyDispatcher(2); // falla 2 veces, luego aceptaría
    const { store, engine } = build(dispatcher);
    const { notification } = await engine.enqueue({
      recipientId: 'pax-1',
      channel: NotificationChannel.SMS,
      template: 'panic.contact_alert',
      priority: NotificationPriority.Critical,
      dedupKey: 'panic:pn2:sms:contact-9',
      payload: { to: '+51900000000', vars: { name: 'Beto', shareLink: 'l', lat: 0, lon: 0 } },
    });

    const r1 = await engine.process(notification);
    expect(r1.status).toBe('RETRY');
    const due1 = await store.findDue(new Date(FIXED_NOW.getTime() + 2_000), 10);
    const r2 = await engine.process(due1[0]!);
    expect(r2.status).toBe('RETRY'); // 2º fallo → sigue reprogramado, no perdido
    const due2 = await store.findDue(new Date(FIXED_NOW.getTime() + 10_000), 10);
    const r3 = await engine.process(due2[0]!);
    expect(r3.status).toBe('SENT'); // 3º entrega
    expect(r3.attempts).toBe(3);
  });
});
