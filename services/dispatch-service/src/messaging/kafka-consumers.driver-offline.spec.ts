/**
 * Fase B (ADR-021 · B-react) — el consumer reacciona a `driver.went_offline`: RETIRA las ofertas OPEN del
 * conductor de los boards (withdrawDriverOffers) y lo EVICTA del pool (evictDriver → hot-index remove). La
 * REASIGNACIÓN la hace trip-service (consume el mismo evento) → dispatch NO reasigna acá; solo limpia su
 * estado efímero. `driver.went_offline` cae en el topic 'driver' ya suscrito (driver.suspended/reactivated)
 * → solo hay que registrar el handler.
 *
 * Verifica SIN Kafka real (espía sobre el KafkaEventConsumer real; handlers registrados por el bootstrap):
 *  1. driver.went_offline → withdrawDriverOffers + evictDriver del conductor.
 *  2. fail-safe: un conductor sin ofertas/loc → ambas son no-op idempotentes (no rompe).
 */
import { describe, it, expect, vi } from 'vitest';
import { createEnvelope, KafkaEventConsumer, type EventHandler } from '@veo/events';
import { KafkaConsumersService } from './kafka-consumers.service';
import type { DispatchService } from '../dispatch/dispatch.service';
import type { OfferBoardService } from '../dispatch/offer-board.service';

const handlers = new Map<string, EventHandler>();
vi.spyOn(KafkaEventConsumer.prototype, 'on').mockImplementation(function (
  this: KafkaEventConsumer,
  eventType: string,
  handler: EventHandler,
) {
  handlers.set(eventType, handler);
  return this;
});
vi.spyOn(KafkaEventConsumer.prototype, 'start').mockResolvedValue(undefined);
vi.spyOn(KafkaEventConsumer.prototype, 'stop').mockResolvedValue(undefined);

const config = {
  getOrThrow: (k: string): string =>
    k === 'KAFKA_BROKERS' ? 'localhost:9094' : k === 'KAFKA_CONSUMER_CONCURRENCY' ? '1' : '',
} as never;

const VALID_DRIVER_ID = '018f9a3e-1c2b-7d4e-8a1f-aaaaaaaaaaaa';

function build() {
  const evictDriver = vi.fn(async () => undefined);
  const withdrawDriverOffers = vi.fn(async () => 0);
  const dispatch = { evictDriver } as unknown as DispatchService;
  const offerBoard = { withdrawDriverOffers } as unknown as OfferBoardService;

  const svc = new KafkaConsumersService(
    config,
    dispatch,
    { cancelSession: async () => {} } as never, // matching
    { recordDemand: async () => {} } as never, // surge
    { registerCancellationInWindow: async () => {} } as never, // projection
    {} as never, // suspensionService
    offerBoard,
    { recordDemand: async () => {} } as never, // heatmap
  );
  return { svc, evictDriver, withdrawDriverOffers };
}

const offlineEnv = (reason: 'shift_end' | 'disconnect' = 'disconnect') =>
  createEnvelope({
    eventType: 'driver.went_offline',
    producer: 'driver-bff',
    payload: { driverId: VALID_DRIVER_ID, at: new Date().toISOString(), reason },
  });

describe('KafkaConsumersService · B-react driver.went_offline (ADR-021 Fase B)', () => {
  it('registra el handler en el topic driver ya suscrito', async () => {
    const { svc } = build();
    await svc.onModuleInit();
    expect(handlers.has('driver.went_offline')).toBe(true);
    await svc.onModuleDestroy();
  });

  it('driver.went_offline → retira ofertas OPEN del conductor + lo evicta del pool', async () => {
    const { svc, evictDriver, withdrawDriverOffers } = build();
    await svc.onModuleInit();
    await handlers.get('driver.went_offline')?.(offlineEnv('disconnect'));
    expect(withdrawDriverOffers).toHaveBeenCalledWith(VALID_DRIVER_ID);
    expect(evictDriver).toHaveBeenCalledWith(VALID_DRIVER_ID);
    await svc.onModuleDestroy();
  });

  it('reason=shift_end sigue el MISMO camino (withdraw + evict)', async () => {
    const { svc, evictDriver, withdrawDriverOffers } = build();
    await svc.onModuleInit();
    await expect(
      handlers.get('driver.went_offline')?.(offlineEnv('shift_end')),
    ).resolves.toBeUndefined();
    expect(withdrawDriverOffers).toHaveBeenCalledWith(VALID_DRIVER_ID);
    expect(evictDriver).toHaveBeenCalledWith(VALID_DRIVER_ID);
    await svc.onModuleDestroy();
  });
});
