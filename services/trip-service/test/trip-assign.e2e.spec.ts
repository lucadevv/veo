/**
 * E2E con Postgres REAL (testcontainers) — la asignación de conductor es un invariante crítico de
 * seguridad/dinero: una doble-asignación = DOS conductores a un mismo pasajero. Sin mock de DB (CLAUDE).
 *
 * Verifica el guard ATÓMICO (CAS) de assign() (D1): el estado va en el WHERE del updateMany, así dos
 * `dispatch.match_found` concurrentes con DISTINTO conductor → exactamente UNO matchea un estado
 * asignable y gana; el otro ve count=0 → InvalidTripTransition (moot, lo ACK-ea assignFromDispatch).
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  runPrismaMigrateDeploy,
  type TestDatabase,
} from '@veo/database/testing';
import { uuidv7 } from '@veo/utils';
import { EVENT_SCHEMAS } from '@veo/events';
import type { MapsClient } from '@veo/maps';
import { PrismaClient } from '../src/generated/prisma';
import { TripsService } from '../src/trips/trips.service';
import type { PrismaService } from '../src/infra/prisma.service';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));

let db: TestDatabase;
let prisma: PrismaClient;
let service: TripsService;

beforeAll(async () => {
  db = await createTestDatabase({
    schema: 'trip',
    applyMigrations: (url) => runPrismaMigrateDeploy(url, serviceDir),
  });
  prisma = new PrismaClient({ datasourceUrl: db.databaseUrl });
  await prisma.$connect();
  // prisma real (NO mock): read y write apuntan al mismo cliente del contenedor.
  const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
  // assign()/assignFromDispatch NO tocan maps/config/redis (opcionales) → un stub alcanza.
  const maps = {} as unknown as MapsClient;
  service = new TripsService(prismaService, maps);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.teardown();
});

/** Inserta un viaje en REQUESTED (estado asignable) con los campos mínimos requeridos. */
async function seedRequestedTrip(): Promise<string> {
  const trip = await prisma.trip.create({
    data: {
      passengerId: uuidv7(),
      originLat: -12.0464,
      originLon: -77.0428,
      destLat: -12.05,
      destLon: -77.05,
      fareCents: 1500,
      distanceMeters: 4000,
      durationSeconds: 600,
      paymentMethod: 'CASH',
      // status default = REQUESTED
    },
  });
  return trip.id;
}

async function assignedEvents(tripId: string) {
  return prisma.outboxEvent.findMany({
    where: { aggregateId: tripId, eventType: 'trip.assigned' },
  });
}

describe('Asignación de conductor · guard atómico CAS (D1: no doble-asignación)', () => {
  it('dos match_found CONCURRENTES con DISTINTO conductor → exactamente UNO asigna (un solo evento)', async () => {
    const tripId = await seedRequestedTrip();
    const driverA = uuidv7();
    const driverB = uuidv7();

    // Carrera real contra Postgres: ambos via assignFromDispatch (ACK-ea al perdedor con la transición moot).
    await Promise.all([
      service.assignFromDispatch(tripId, driverA),
      service.assignFromDispatch(tripId, driverB),
    ]);

    const trip = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
    expect(trip.status).toBe('ASSIGNED');
    // El viaje quedó asignado a UNO de los dos (no a un mix imposible), con su assignedAt.
    expect([driverA, driverB]).toContain(trip.driverId);
    expect(trip.assignedAt).toBeInstanceOf(Date);

    // Exactamente UN trip.assigned, y su driverId === el que realmente quedó asignado (sin doble fan-out).
    const events = await assignedEvents(tripId);
    expect(events).toHaveLength(1);
    const payload = (events[0]!.envelope as { payload: { driverId: string } }).payload;
    expect(payload.driverId).toBe(trip.driverId);
  });

  it('redelivery del MISMO conductor es idempotente: no re-asigna ni emite un segundo evento', async () => {
    const tripId = await seedRequestedTrip();
    const driver = uuidv7();
    await service.assignFromDispatch(tripId, driver);
    await service.assignFromDispatch(tripId, driver); // at-least-once: mismo match_found otra vez

    const trip = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
    expect(trip.driverId).toBe(driver);
    expect(await assignedEvents(tripId)).toHaveLength(1);
  });

  it('match_found para un viaje TERMINAL (COMPLETED) → no asigna, no evento (moot, ACK)', async () => {
    const tripId = await seedRequestedTrip();
    await prisma.trip.update({ where: { id: tripId }, data: { status: 'COMPLETED' } });

    // No debe lanzar (assignFromDispatch traga la InvalidTripTransition permanente y ACK-ea).
    await expect(service.assignFromDispatch(tripId, uuidv7())).resolves.toBeUndefined();

    const trip = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
    expect(trip.status).toBe('COMPLETED'); // intacto
    expect(trip.driverId).toBeNull();
    expect(await assignedEvents(tripId)).toHaveLength(0);
  });

  it('re-match desde REASSIGNING (conductor previo canceló) SÍ asigna (REASSIGNING es fuente válida)', async () => {
    const tripId = await seedRequestedTrip();
    await prisma.trip.update({ where: { id: tripId }, data: { status: 'REASSIGNING' } });
    const driver = uuidv7();
    await service.assignFromDispatch(tripId, driver);

    const trip = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
    expect(trip.status).toBe('ASSIGNED');
    expect(trip.driverId).toBe(driver);
    expect(await assignedEvents(tripId)).toHaveLength(1);
  });
});

/** Inserta un viaje ACCEPTED (con conductor) en el modo dado. agreedFareCents seteado para verificar el reset H12. */
async function seedAcceptedTrip(mode: 'PUJA' | 'FIXED'): Promise<string> {
  const trip = await prisma.trip.create({
    data: {
      passengerId: uuidv7(),
      driverId: uuidv7(),
      originLat: -12.0464,
      originLon: -77.0428,
      destLat: -12.05,
      destLon: -77.05,
      fareCents: 1500,
      distanceMeters: 4000,
      durationSeconds: 600,
      paymentMethod: 'CASH',
      status: 'ACCEPTED',
      dispatchMode: mode,
      vehicleType: 'CAR',
      negotiationSeq: 1,
      agreedFareCents: 1500, // un agreed-fare vivo: el reassign PUJA debe RESETEARLO (H12)
    },
  });
  return trip.id;
}

/**
 * El camino de PLATA del reassign (cancel del conductor → Strategy.reassign) contra Postgres REAL. Cierra
 * el hueco: el outbox `trip.reassigning` se valida contra su EVENT_SCHEMAS (lo que un prisma falso NO hace;
 * un campo roto explotaría recién en el consumer de dispatch como poison, no acá).
 */
describe('Reassign tras cancel del conductor · Strategy por modo · Postgres real', () => {
  it('PUJA · cancel(DRIVER) desde ACCEPTED → REASSIGNING + reset H12 + bump H13 + trip.reassigning VÁLIDO', async () => {
    const tripId = await seedAcceptedTrip('PUJA');
    const view = await service.cancel(tripId, { by: 'DRIVER' });
    expect(view.status).toBe('REASSIGNING');

    const trip = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
    expect(trip.driverId).toBeNull(); // conductor liberado
    expect(trip.agreedFareCents).toBeNull(); // H12: guard reseteado (el re-match cobra el precio fresco)
    expect(trip.negotiationSeq).toBe(2); // H13: ciclo bumpeado 1→2

    // El payload REAL del outbox DEBE pasar el schema que el consumer de dispatch usa para parsear.
    const events = await prisma.outboxEvent.findMany({
      where: { aggregateId: tripId, eventType: 'trip.reassigning' },
    });
    expect(events).toHaveLength(1);
    const payload = (events[0]!.envelope as { payload: unknown }).payload;
    const parsed = EVENT_SCHEMAS['trip.reassigning'].parse(payload); // lanza si falta/sobra un campo
    expect(parsed.negotiationSeq).toBe(2); // el seq enriquecido coincide con la fila
  });

  it('FIXED · cancel(DRIVER) desde ACCEPTED → REASSIGNING + re-emite trip.requested SIN tocar seq/agreedFare', async () => {
    const tripId = await seedAcceptedTrip('FIXED');
    const view = await service.cancel(tripId, { by: 'DRIVER' });
    expect(view.status).toBe('REASSIGNING');

    const trip = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
    expect(trip.driverId).toBeNull();
    // FIXED NO toca los invariantes de puja (asimetría preservada contra Postgres real).
    expect(trip.agreedFareCents).toBe(1500);
    expect(trip.negotiationSeq).toBe(1);

    // FIXED re-emite trip.requested (no trip.reassigning), y ese payload también pasa su schema.
    const requested = await prisma.outboxEvent.findMany({
      where: { aggregateId: tripId, eventType: 'trip.requested' },
    });
    expect(requested).toHaveLength(1);
    expect(() =>
      EVENT_SCHEMAS['trip.requested'].parse(
        (requested[0]!.envelope as { payload: unknown }).payload,
      ),
    ).not.toThrow();
    const reassigning = await prisma.outboxEvent.findMany({
      where: { aggregateId: tripId, eventType: 'trip.reassigning' },
    });
    expect(reassigning).toHaveLength(0); // FIXED NO emite trip.reassigning
  });
});
