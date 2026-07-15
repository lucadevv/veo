/**
 * Tests del derecho al olvido (BR-S06, Ley 29733) en trip-service:
 *  - TripsService.anonymizePassenger borra la PII de localización conservando la fila.
 *  - El consumidor user.deleted invoca la anonimización y es idempotente (reproceso = no-op).
 *
 * Estilo identity/trip: se construyen las clases directamente con dobles, sin Nest DI.
 */
import { describe, it, expect } from 'vitest';
import { Prisma } from '../generated/prisma';
import { TripsService } from './trips.service';
import { TripsRepository } from './trips.repository';
import { UserDeletedConsumer } from './user-deleted.consumer';
import type { EventEnvelope } from '@veo/events';

interface TripRow {
  id: string;
  passengerId: string;
  originLat: number;
  originLon: number;
  destLat: number;
  destLon: number;
  waypoints: unknown;
  routePolyline: string | null;
}

interface OutboxRow {
  aggregateId: string;
  eventType: string;
  envelope: { eventType: string; payload: Record<string, unknown> };
}

/**
 * Prisma falso con una tabla de viajes en memoria; implementa read.findMany (ids afectados),
 * write.$transaction y, dentro de la transacción, updateMany (purga) + outboxEvent.create (señal
 * trip.pii_erased por viaje, en la misma transacción — outbox pattern).
 */
function makePrisma(rows: TripRow[]) {
  const updateManyCalls: { where: unknown; data: Record<string, unknown> }[] = [];
  const outbox: OutboxRow[] = [];

  const tx = {
    trip: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { passengerId: string };
        data: Record<string, unknown>;
      }) => {
        updateManyCalls.push({ where, data });
        let count = 0;
        for (const row of rows) {
          if (row.passengerId !== where.passengerId) continue;
          count++;
          row.originLat = data.originLat as number;
          row.originLon = data.originLon as number;
          row.destLat = data.destLat as number;
          row.destLon = data.destLon as number;
          row.waypoints = data.waypoints;
          row.routePolyline = data.routePolyline as string | null;
        }
        return { count };
      },
    },
    outboxEvent: {
      create: async ({
        data,
      }: {
        data: { aggregateId: string; eventType: string; envelope: OutboxRow['envelope'] };
      }) => {
        outbox.push({
          aggregateId: data.aggregateId,
          eventType: data.eventType,
          envelope: data.envelope,
        });
        return {};
      },
    },
  };

  const prisma = {
    read: {
      trip: {
        findMany: async ({ where }: { where: { passengerId: string } }) =>
          rows.filter((r) => r.passengerId === where.passengerId).map((r) => ({ id: r.id })),
      },
    },
    write: {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
  return { prisma, updateManyCalls, outbox };
}

function makeService(rows: TripRow[]) {
  const { prisma, updateManyCalls, outbox } = makePrisma(rows);
  // El ctor real recibe (PrismaService, MapsClient); aquí solo ejercitamos la purga.
  const service = new TripsService(new TripsRepository(prisma as never), {} as never);
  return { service, updateManyCalls, outbox };
}

let rowSeq = 0;
function buildRow(passengerId: string): TripRow {
  return {
    id: `trip-${++rowSeq}`,
    passengerId,
    originLat: -12.0464,
    originLon: -77.0428,
    destLat: -12.1219,
    destLon: -77.0297,
    waypoints: [{ lat: -12.05, lon: -77.04 }],
    routePolyline: 'encoded-route-polyline',
  };
}

function envelope(payload: unknown): EventEnvelope<unknown> {
  return {
    eventId: 'evt-1',
    eventType: 'user.deleted',
    occurredAt: '2026-06-04T00:00:00.000Z',
    producer: 'identity-service',
    schemaVersion: 1,
    payload,
  };
}

describe('TripsService.anonymizePassenger (derecho al olvido)', () => {
  it('cero-iza coordenadas y nulifica waypoints/ruta del pasajero, conservando la fila', async () => {
    const rows = [buildRow('pax-1'), buildRow('pax-2')];
    const { service } = makeService(rows);

    const res = await service.anonymizePassenger('pax-1');

    expect(res.anonymized).toBe(1);
    const target = rows.find((r) => r.passengerId === 'pax-1')!;
    expect(target.originLat).toBe(0);
    expect(target.originLon).toBe(0);
    expect(target.destLat).toBe(0);
    expect(target.destLon).toBe(0);
    expect(target.waypoints).toBe(Prisma.DbNull);
    expect(target.routePolyline).toBeNull();
    // La fila sigue existiendo (no se borró) y el otro pasajero queda intacto.
    expect(rows).toHaveLength(2);
    const other = rows.find((r) => r.passengerId === 'pax-2')!;
    expect(other.originLat).toBe(-12.0464);
    expect(other.routePolyline).toBe('encoded-route-polyline');
  });

  it('es idempotente: reprocesar deja la fila idéntica (sobre-escritura determinista)', async () => {
    const rows = [buildRow('pax-1')];
    const { service, updateManyCalls } = makeService(rows);

    await service.anonymizePassenger('pax-1');
    const snapshot = { ...rows[0] };
    await service.anonymizePassenger('pax-1');

    expect(rows[0]).toEqual(snapshot);
    // El where filtra por passengerId en ambas pasadas; los datos son siempre los mismos.
    expect(updateManyCalls).toHaveLength(2);
    expect(updateManyCalls[0]!.data).toEqual(updateManyCalls[1]!.data);
    expect(updateManyCalls[0]!.where).toEqual({ passengerId: 'pax-1' });
  });

  it('emite UN trip.pii_erased por viaje anonimizado (cascada de purga de video), en outbox', async () => {
    const rows = [buildRow('pax-1'), buildRow('pax-1'), buildRow('pax-2')];
    const paxTripIds = rows.filter((r) => r.passengerId === 'pax-1').map((r) => r.id);
    const { service, outbox } = makeService(rows);

    await service.anonymizePassenger('pax-1');

    const erased = outbox.filter((o) => o.eventType === 'trip.pii_erased');
    // Una señal por viaje del pasajero (2), ninguna por el viaje ajeno.
    expect(erased).toHaveLength(2);
    expect(erased.map((o) => o.aggregateId).sort()).toEqual([...paxTripIds].sort());
    for (const o of erased) {
      expect(o.envelope.payload.passengerId).toBe('pax-1');
      expect(paxTripIds).toContain(o.envelope.payload.tripId as string);
      expect(typeof o.envelope.payload.at).toBe('string');
    }
  });

  it('idempotente en la emisión: reprocesar reemite la misma señal por viaje (media deduplica)', async () => {
    const rows = [buildRow('pax-1')];
    const { service, outbox } = makeService(rows);

    await service.anonymizePassenger('pax-1');
    await service.anonymizePassenger('pax-1');

    const erased = outbox.filter((o) => o.eventType === 'trip.pii_erased');
    // 1 viaje × 2 reprocesos = 2 señales con el mismo tripId; la idempotencia real la garantiza
    // media-service (dedup por eventId + borrado no-op).
    expect(erased).toHaveLength(2);
    expect(erased[0]!.aggregateId).toBe(erased[1]!.aggregateId);
  });

  it('no emite señal alguna si el pasajero no tiene viajes', async () => {
    const rows = [buildRow('pax-2')];
    const { service, outbox } = makeService(rows);

    await service.anonymizePassenger('pax-1');

    expect(outbox).toHaveLength(0);
  });

  it('no afecta a nadie si el pasajero no tiene viajes (count 0)', async () => {
    const rows = [buildRow('pax-2')];
    const { service } = makeService(rows);

    const res = await service.anonymizePassenger('pax-1');

    expect(res.anonymized).toBe(0);
    expect(rows[0]!.originLat).toBe(-12.0464);
  });
});

describe('UserDeletedConsumer', () => {
  function makeConsumer(rows: TripRow[]) {
    const { service, updateManyCalls } = makeService(rows);
    const config = {
      getOrThrow: (key: string) => (key === 'KAFKA_BROKERS' ? 'localhost:9094' : ''),
    };
    const consumer = new UserDeletedConsumer(service, config as never);
    return { consumer, service, updateManyCalls };
  }

  it('anonimiza los viajes del usuario al recibir user.deleted', async () => {
    const rows = [buildRow('user-1')];
    const { consumer } = makeConsumer(rows);

    await (
      consumer as unknown as {
        onUserDeleted(e: EventEnvelope<unknown>): Promise<void>;
      }
    ).onUserDeleted(envelope({ userId: 'user-1', at: '2026-06-04T00:00:00.000Z' }));

    expect(rows[0]!.originLat).toBe(0);
    expect(rows[0]!.routePolyline).toBeNull();
  });

  it('ignora payloads inválidos sin tocar la base (no lanza)', async () => {
    const rows = [buildRow('user-1')];
    const { consumer, updateManyCalls } = makeConsumer(rows);

    await (
      consumer as unknown as {
        onUserDeleted(e: EventEnvelope<unknown>): Promise<void>;
      }
    ).onUserDeleted(envelope({ wrong: 'shape' }));

    expect(updateManyCalls).toHaveLength(0);
    expect(rows[0]!.originLat).toBe(-12.0464);
  });

  it('es idempotente al reprocesar el mismo user.deleted', async () => {
    const rows = [buildRow('user-1')];
    const { consumer } = makeConsumer(rows);
    const evt = envelope({ userId: 'user-1', at: '2026-06-04T00:00:00.000Z' });

    await (
      consumer as unknown as {
        onUserDeleted(e: EventEnvelope<unknown>): Promise<void>;
      }
    ).onUserDeleted(evt);
    const snapshot = { ...rows[0] };
    await (
      consumer as unknown as {
        onUserDeleted(e: EventEnvelope<unknown>): Promise<void>;
      }
    ).onUserDeleted(evt);

    expect(rows[0]).toEqual(snapshot);
  });
});
