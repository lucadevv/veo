/**
 * EventsConsumer · pánico (B1): el consumer YA NO manda SMS inline. Al recibir panic.triggered,
 * actualiza el read-model, junta los IDs de los contactos verificados y DELEGA el fan-out durable a
 * notification-service vía ShareService.createPanicFanout (que crea el enlace + encola
 * panic.fanout_requested en una transacción). Nada de this.sms.send acá.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { createEnvelope, KafkaEventConsumer } from '@veo/events';
import { EventsConsumer } from './events.consumer';
import { ShareService } from '../share/share.service';
import { ContactsService } from '../contacts/contacts.service';
import { TripSnapshotService } from '../read-model/trip-snapshot.service';
import type { Env } from '../config/env.schema';

// El bootstrap Kafka real no debe abrir sockets en el test.
vi.spyOn(KafkaEventConsumer.prototype, 'start').mockResolvedValue(undefined);
vi.spyOn(KafkaEventConsumer.prototype, 'stop').mockResolvedValue(undefined);

const config = new ConfigService<Env, true>({
  KAFKA_BROKERS: 'localhost:9094',
  KAFKA_CONSUMER_GROUP: 'share-service',
  SHARE_LINK_TTL_SECONDS: 3600,
  SHARE_LINK_MAX_USES: 50,
} as never);

interface ContactRow {
  id: string;
  phone: string;
  name: string;
}

function build(verified: ContactRow[]) {
  const snapshots = {
    onPanic: vi.fn(async () => undefined),
    onPanicResolved: vi.fn(async () => undefined),
  } as unknown as TripSnapshotService;
  const contacts = {
    listVerified: vi.fn(async () => verified),
  } as unknown as ContactsService;
  const createPanicFanout: ReturnType<typeof vi.fn> = vi.fn(
    async (..._args: Parameters<ShareService['createPanicFanout']>) => ({
      shareId: 's1',
      url: 'https://veo.pe/f/tok',
      emitted: true,
    }),
  );
  const revokeAllForTrip: ReturnType<typeof vi.fn> = vi.fn(async (_tripId: string) => ({ revoked: 1 }));
  const share = { createPanicFanout, revokeAllForTrip } as unknown as ShareService;

  const consumer = new EventsConsumer(share, contacts, snapshots, config);
  return { consumer, snapshots, contacts, share, createPanicFanout, revokeAllForTrip };
}

function panicEnvelope() {
  return createEnvelope({
    eventType: 'panic.triggered',
    producer: 'panic-service',
    payload: {
      panicId: 'pn-1',
      tripId: 'trip-1',
      passengerId: 'pax-1',
      geo: { lat: -12.04, lon: -77.04 },
      dedupKey: 'd1',
      triggeredAt: new Date().toISOString(),
    },
  });
}

/** Accede a un handler (privado) por tipo de evento tipándolo via index sin usar any. */
function handlerFor(consumer: EventsConsumer, eventType: string) {
  const handlers = (consumer as unknown as { handlers(): Record<string, (e: unknown) => Promise<void>> }).handlers();
  return handlers[eventType]!;
}

/** Atajo legacy para el handler de pánico (mantiene las pruebas de pánico legibles). */
function panicHandler(consumer: EventsConsumer) {
  return handlerFor(consumer, 'panic.triggered');
}

function terminalEnvelope(eventType: 'trip.completed' | 'trip.cancelled' | 'trip.failed') {
  const base = { tripId: 'trip-1' };
  const payload =
    eventType === 'trip.completed'
      ? { ...base, fareCents: 1500, distanceMeters: 4200, durationSeconds: 900 }
      : eventType === 'trip.cancelled'
        ? { ...base, by: 'PASSENGER' as const, penaltyCents: 0 }
        : { ...base, passengerId: 'pax-1', fromStatus: 'IN_PROGRESS', staleMinutes: 30, at: new Date().toISOString() };
  return createEnvelope({ eventType, producer: 'trip-service', payload });
}

describe('EventsConsumer.handlePanic · delega el fan-out (no SMS inline)', () => {
  it('con contactos verificados → llama createPanicFanout con los contactIds (sin teléfonos)', async () => {
    const { consumer, createPanicFanout, snapshots } = build([
      { id: 'c1', phone: '+51911111111', name: 'Ana' },
      { id: 'c2', phone: '+51922222222', name: 'Beto' },
    ]);

    await panicHandler(consumer)(panicEnvelope());

    expect(snapshots.onPanic).toHaveBeenCalledOnce();
    expect(createPanicFanout).toHaveBeenCalledOnce();
    const [tripId, input] = createPanicFanout.mock.calls[0]!;
    expect(tripId).toBe('trip-1');
    expect(input).toMatchObject({ panicId: 'pn-1', passengerId: 'pax-1', contactIds: ['c1', 'c2'] });
    // El argumento del fan-out lleva SOLO IDs: ningún teléfono/nombre.
    expect(JSON.stringify(input)).not.toMatch(/\+51|Ana|Beto/);
  });

  it('cap BR-S05: a lo sumo 4 contactIds delegados', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, phone: `+519${i}`, name: `N${i}` }));
    const { consumer, createPanicFanout } = build(many);

    await panicHandler(consumer)(panicEnvelope());

    const [, input] = createPanicFanout.mock.calls[0]!;
    expect((input as { contactIds: string[] }).contactIds).toHaveLength(4);
  });

  it('sin contactos verificados → no delega (warn) y no rompe', async () => {
    const { consumer, createPanicFanout } = build([]);
    await panicHandler(consumer)(panicEnvelope());
    expect(createPanicFanout).not.toHaveBeenCalled();
  });

  it('si createPanicFanout falla → RELANZA (Kafka reintenta; no ACKea a ciegas)', async () => {
    const { consumer, share } = build([{ id: 'c1', phone: '+51911111111', name: 'Ana' }]);
    (share.createPanicFanout as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db caída'));
    await expect(panicHandler(consumer)(panicEnvelope())).rejects.toThrow('db caída');
  });
});

function resolvedEnvelope(status: 'RESOLVED' | 'FALSE_ALARM') {
  return createEnvelope({
    eventType: 'panic.resolved',
    producer: 'panic-service',
    payload: {
      panicId: 'pn-1',
      tripId: 'trip-1',
      passengerId: 'pax-1',
      status,
      resolvedBy: 'op-1',
      at: new Date().toISOString(),
    },
  });
}

describe('EventsConsumer.handlePanicResolved · desenmascarado condicional (seguridad física)', () => {
  it('FALSE_ALARM → delega a onPanicResolved(tripId, FALSE_ALARM)', async () => {
    const { consumer, snapshots } = build([]);
    await handlerFor(consumer, 'panic.resolved')(resolvedEnvelope('FALSE_ALARM'));
    expect(snapshots.onPanicResolved).toHaveBeenCalledOnce();
    expect(snapshots.onPanicResolved).toHaveBeenCalledWith('trip-1', 'FALSE_ALARM');
  });

  it('ADVERSARIAL · RESOLVED → delega a onPanicResolved(tripId, RESOLVED) (la rama lo MANTIENE enmascarado)', async () => {
    const { consumer, snapshots } = build([]);
    await handlerFor(consumer, 'panic.resolved')(resolvedEnvelope('RESOLVED'));
    // El consumer propaga el status TIPADO tal cual; onPanicResolved es quien NO desenmascara en RESOLVED.
    expect(snapshots.onPanicResolved).toHaveBeenCalledWith('trip-1', 'RESOLVED');
  });
});

describe('EventsConsumer · auto-revoke al terminar el viaje (kill-switch R3)', () => {
  it.each(['trip.completed', 'trip.cancelled', 'trip.failed'] as const)(
    '%s → revoca todos los enlaces del viaje por tripId',
    async (eventType) => {
      const { consumer, revokeAllForTrip } = build([]);
      await handlerFor(consumer, eventType)(terminalEnvelope(eventType));
      expect(revokeAllForTrip).toHaveBeenCalledOnce();
      expect(revokeAllForTrip).toHaveBeenCalledWith('trip-1');
    },
  );

  it('idempotente: sin enlaces vivos (revoked=0) no rompe', async () => {
    const { consumer, revokeAllForTrip } = build([]);
    (revokeAllForTrip as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ revoked: 0 });
    await expect(
      handlerFor(consumer, 'trip.completed')(terminalEnvelope('trip.completed')),
    ).resolves.toBeUndefined();
  });
});
