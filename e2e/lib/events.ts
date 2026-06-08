/**
 * Colector de eventos Kafka para los asserts del golden path. Se suscribe a los topics de dominio
 * (topic = prefijo antes del punto: trip, dispatch, payment, panic, driver, user) y guarda los
 * envelopes recibidos. El test puede esperar (`waitForEvent`) un evento que cumpla un predicado.
 *
 * Usa kafkajs directo (no @veo/events) para mantener el e2e desacoplado del workspace; el formato
 * del envelope es { eventType, payload, ... } (FOUNDATION §6 / @veo/events createEnvelope).
 */
import { Kafka, type Consumer } from 'kafkajs';
import { INFRA } from './config.js';

export interface DomainEvent {
  eventType: string;
  payload: Record<string, unknown>;
  receivedAt: number;
}

export class EventCollector {
  private readonly kafka: Kafka;
  private consumer?: Consumer;
  private readonly events: DomainEvent[] = [];
  private readonly waiters: Array<{
    predicate: (e: DomainEvent) => boolean;
    resolve: (e: DomainEvent) => void;
  }> = [];

  constructor(private readonly topics: string[]) {
    this.kafka = new Kafka({
      clientId: 'veo-e2e-collector',
      brokers: [INFRA.kafkaBroker],
      retry: { retries: 3 },
    });
  }

  /** Conecta y empieza a consumir desde el final (solo eventos a partir de ahora). */
  async start(): Promise<void> {
    this.consumer = this.kafka.consumer({ groupId: `veo-e2e-${Date.now()}` });
    await this.consumer.connect();
    for (const topic of this.topics) {
      await this.consumer.subscribe({ topic, fromBeginning: false });
    }
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(message.value.toString());
        } catch {
          return;
        }
        const env = parsed as { eventType?: string; payload?: Record<string, unknown> };
        if (!env.eventType) return;
        const evt: DomainEvent = {
          eventType: env.eventType,
          payload: env.payload ?? {},
          receivedAt: Date.now(),
        };
        this.events.push(evt);
        for (let i = this.waiters.length - 1; i >= 0; i--) {
          const w = this.waiters[i];
          if (w && w.predicate(evt)) {
            w.resolve(evt);
            this.waiters.splice(i, 1);
          }
        }
      },
    });
  }

  /** Eventos ya recibidos que cumplen el predicado. */
  find(predicate: (e: DomainEvent) => boolean): DomainEvent[] {
    return this.events.filter(predicate);
  }

  /** Espera un evento (ya recibido o futuro) que cumpla el predicado. */
  waitForEvent(
    predicate: (e: DomainEvent) => boolean,
    opts: { timeoutMs: number; label: string },
  ): Promise<DomainEvent> {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<DomainEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === wrapped);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`Timeout esperando evento Kafka: ${opts.label} (${opts.timeoutMs}ms)`));
      }, opts.timeoutMs);
      const wrapped = (e: DomainEvent): void => {
        clearTimeout(timer);
        resolve(e);
      };
      this.waiters.push({ predicate, resolve: wrapped });
    });
  }

  async stop(): Promise<void> {
    await this.consumer?.disconnect();
  }
}
