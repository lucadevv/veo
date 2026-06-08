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
import { createTestDatabase, runPrismaMigrateDeploy, type TestDatabase } from '@veo/database/testing';
import { uuidv7 } from '@veo/utils';
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
