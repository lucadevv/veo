/**
 * E2E con Postgres REAL (testcontainers) — el SEAT-LOCK del §6 es el ÚNICO anti-oversold del sistema y un
 * invariante de NEGOCIO crítico (un asiento vendido dos veces = un pasajero sin lugar tras cobrarle). Un lock
 * PESIMISTA (`SELECT ... FOR UPDATE`) NO se verifica con mocks: necesita una DB real que lo serialice. CLAUDE:
 * "no mockear DB en tests críticos (payments/panic/audit)" — el seat-lock cae de lleno ahí.
 *
 * QUÉ PRUEBA (ADR-014 §6, el corazón de F3c):
 *  - N `payment.captured` CONCURRENTES sobre el ÚLTIMO asiento → EXACTAMENTE UNO confirma (decrementa a 0 +
 *    PublishedTrip → LLENO); el resto va a CANCELADO(ASIENTO_LLENO). NUNCA oversold (asientosDisponibles >= 0).
 *  - El `FOR UPDATE` serializa los handlers del mismo viaje: el 2º espera al 1º y re-lee el valor decrementado.
 *  - Multi-asiento: un booking que pide 2 sobre 3 disponibles confirma; otro que pide 2 a la vez ve 1 → ASIENTO_LLENO.
 *  - Idempotencia: un payment.captured DUPLICADO (segunda corrida del mismo booking ya CONFIRMADO) → NOOP, sin
 *    doble-decremento.
 *  - Camino feliz parcial: 1 de 3 confirma → PublishedTrip PUBLICADO → PARCIALMENTE_RESERVADO, disp = 2.
 *
 * Construye BookingsRepository directo con un PrismaClient real del contenedor (sin Nest DI), espejo de
 * payment-service/test/capture-idempotency.e2e.spec.ts.
 */
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, runPrismaMigrateDeploy, type TestDatabase } from '@veo/database/testing';
import { uuidv7 } from '@veo/utils';
import { PrismaClient, BookingState, PublishedTripState, ModoReserva, PaymentMethod } from '../src/generated/prisma';
import { BookingsRepository } from '../src/bookings/bookings.repository';
import type { PrismaService } from '../src/infra/prisma.service';

const serviceDir = fileURLToPath(new URL('..', import.meta.url));

let db: TestDatabase;
let prisma: PrismaClient;
let repo: BookingsRepository;

const DRIVER = '0192f8a0-0000-7000-8000-0000000000d1';
const VEHICLE = '0192f8a0-0000-7000-8000-0000000000e1';

beforeAll(async () => {
  db = await createTestDatabase({
    schema: 'booking',
    applyMigrations: (url) => runPrismaMigrateDeploy(url, serviceDir),
  });
  prisma = new PrismaClient({ datasourceUrl: db.databaseUrl });
  await prisma.$connect();
  // Prisma real (NO mock): read y write apuntan al mismo cliente del contenedor.
  const prismaService = { read: prisma, write: prisma } as unknown as PrismaService;
  repo = new BookingsRepository(prismaService);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.teardown();
});

afterEach(async () => {
  // Limpieza entre tests (bookings → trips por la FK; outbox suelto).
  await prisma.booking.deleteMany({});
  await prisma.publishedTrip.deleteMany({});
  await prisma.outboxEvent.deleteMany({});
});

/** Siembra una oferta PUBLICADA con `asientos` disponibles (== totales) y devuelve su id. */
async function seedTrip(asientos: number): Promise<string> {
  const id = uuidv7();
  await prisma.publishedTrip.create({
    data: {
      id,
      driverId: DRIVER,
      vehicleId: VEHICLE,
      origenLat: -12.05,
      origenLon: -77.04,
      destinoLat: -13.52,
      destinoLon: -71.97,
      fechaHoraSalida: new Date(Date.now() + 86_400_000),
      asientosTotales: asientos,
      asientosDisponibles: asientos,
      precioBase: 4500,
      modoReserva: ModoReserva.INSTANT_BOOKING,
      estado: PublishedTripState.PUBLICADO,
    },
  });
  return id;
}

/** Siembra un booking en COBRO_PENDIENTE (el estado del que parte el seat-lock) sobre la oferta. */
async function seedPendingBooking(tripId: string, asientos: number): Promise<string> {
  const id = uuidv7();
  await prisma.booking.create({
    data: {
      id,
      publishedTripId: tripId,
      passengerId: uuidv7(),
      asientos,
      pickupLat: -12.05,
      pickupLon: -77.04,
      dropoffLat: -13.52,
      dropoffLon: -71.97,
      precioAcordado: 4500 * asientos,
      paymentMethod: PaymentMethod.YAPE,
      dedupKey: `booking:req:${uuidv7()}:${uuidv7()}`,
      estado: BookingState.COBRO_PENDIENTE,
    },
  });
  return id;
}

async function getTrip(id: string) {
  return prisma.publishedTrip.findUniqueOrThrow({ where: { id } });
}
async function getBooking(id: string) {
  return prisma.booking.findUniqueOrThrow({ where: { id } });
}
/** Eventos booking.cancelled con una razon dada, emitidos al outbox por el seat-lock. */
async function cancelledOutbox(aggregateId: string) {
  return prisma.outboxEvent.findMany({
    where: { aggregateId, eventType: 'booking.cancelled' },
  });
}

describe('SEAT-LOCK §6 · anti-oversold con Postgres REAL (FOR UPDATE)', () => {
  it('N=5 capturas CONCURRENTES sobre el ÚLTIMO asiento → EXACTAMENTE 1 CONFIRMA, 4 ASIENTO_LLENO, nunca oversold', async () => {
    const tripId = await seedTrip(1); // 1 solo asiento.
    const bookingIds = await Promise.all(
      Array.from({ length: 5 }, () => seedPendingBooking(tripId, 1)),
    );

    // Cada booking lee su fila fresca y dispara el seat-lock EN PARALELO (carrera real contra Postgres). El
    // FOR UPDATE serializa: el 1º decrementa a 0; los otros 4 re-leen 0 < 1 → ASIENTO_LLENO.
    const outcomes = await Promise.all(
      bookingIds.map(async (id) => {
        const booking = await prisma.booking.findUniqueOrThrow({ where: { id } });
        return repo.confirmAndLockSeats(booking, uuidv7());
      }),
    );

    const confirmed = outcomes.filter((o) => o.kind === 'CONFIRMED');
    const seatFull = outcomes.filter((o) => o.kind === 'SEAT_FULL');
    expect(confirmed).toHaveLength(1); // EXACTAMENTE uno gana el asiento.
    expect(seatFull).toHaveLength(4); // el resto: cobré pero el asiento se llenó.

    const trip = await getTrip(tripId);
    expect(trip.asientosDisponibles).toBe(0); // NUNCA oversold (>= 0, y exacto 0: el único confirmado lo tomó).
    expect(trip.asientosDisponibles).toBeGreaterThanOrEqual(0);
    expect(trip.estado).toBe(PublishedTripState.LLENO); // llegó a 0 → LLENO.

    // Estados de los bookings: 1 CONFIRMADO, 4 CANCELADO; cada cancelado emitió booking.cancelled(ASIENTO_LLENO).
    const estados = await Promise.all(bookingIds.map((id) => getBooking(id).then((b) => b.estado)));
    expect(estados.filter((e) => e === BookingState.CONFIRMADO)).toHaveLength(1);
    expect(estados.filter((e) => e === BookingState.CANCELADO)).toHaveLength(4);

    for (const id of bookingIds) {
      const b = await getBooking(id);
      if (b.estado === BookingState.CANCELADO) {
        const evts = await cancelledOutbox(id);
        expect(evts).toHaveLength(1);
        const payload = evts[0]?.envelope as { payload?: { razon?: string } };
        expect(payload.payload?.razon).toBe('ASIENTO_LLENO');
      }
    }
  });

  it('happy: 1 captura sobre 3 asientos → CONFIRMADO, disp=2, PublishedTrip PUBLICADO → PARCIALMENTE_RESERVADO', async () => {
    const tripId = await seedTrip(3);
    const bookingId = await seedPendingBooking(tripId, 1);
    const booking = await getBooking(bookingId);

    const outcome = await repo.confirmAndLockSeats(booking, uuidv7());
    expect(outcome.kind).toBe('CONFIRMED');

    const trip = await getTrip(tripId);
    expect(trip.asientosDisponibles).toBe(2);
    expect(trip.estado).toBe(PublishedTripState.PARCIALMENTE_RESERVADO);
    expect((await getBooking(bookingId)).estado).toBe(BookingState.CONFIRMADO);
    // booking.confirmed emitido al outbox.
    const confirmedEvt = await prisma.outboxEvent.findMany({
      where: { aggregateId: bookingId, eventType: 'booking.confirmed' },
    });
    expect(confirmedEvt).toHaveLength(1);
  });

  it('multi-asiento: pide 2 sobre 1 disponible → ASIENTO_LLENO (no decrementa por debajo de 0)', async () => {
    const tripId = await seedTrip(1);
    const bookingId = await seedPendingBooking(tripId, 2); // pide 2, solo hay 1.
    const booking = await getBooking(bookingId);

    const outcome = await repo.confirmAndLockSeats(booking, uuidv7());
    expect(outcome.kind).toBe('SEAT_FULL');

    const trip = await getTrip(tripId);
    expect(trip.asientosDisponibles).toBe(1); // intacto: nunca bajó (ni a -1).
    expect(trip.estado).toBe(PublishedTripState.PUBLICADO);
    expect((await getBooking(bookingId)).estado).toBe(BookingState.CANCELADO);
  });

  it('idempotencia: payment.captured DUPLICADO sobre un booking YA CONFIRMADO → NOOP, sin doble-decremento', async () => {
    const tripId = await seedTrip(2);
    const bookingId = await seedPendingBooking(tripId, 1);
    const booking = await getBooking(bookingId);

    const first = await repo.confirmAndLockSeats(booking, uuidv7());
    expect(first.kind).toBe('CONFIRMED');
    expect((await getTrip(tripId)).asientosDisponibles).toBe(1);

    // 2ª corrida con el MISMO booking (ya CONFIRMADO): el where atómico `estado: COBRO_PENDIENTE` no matchea →
    // NOOP. El asiento NO se decrementa de nuevo (sigue 1, no 0).
    const second = await repo.confirmAndLockSeats(booking, uuidv7());
    expect(second.kind).toBe('NOOP');
    expect((await getTrip(tripId)).asientosDisponibles).toBe(1); // SIN doble-decremento.
  });

  it('GUARD F3c: oferta en estado NO-reservable (CANCELADO) → OFFER_UNAVAILABLE, cancela limpio SIN poison/throw', async () => {
    const tripId = await seedTrip(3);
    const bookingId = await seedPendingBooking(tripId, 1);
    // La oferta pasa a un estado NO-reservable (simula el escenario futuro F4 / anomalía): el seat-lock NO debe
    // intentar assertTransition(... → LLENO) y envenenar — debe cancelar el booking limpio. CANCELADO es terminal
    // y no-reservable, sirve para ejercitar el guard sin construir el camino EN_RUTA de F4.
    await prisma.publishedTrip.update({
      where: { id: tripId },
      data: { estado: PublishedTripState.CANCELADO },
    });
    const booking = await getBooking(bookingId);

    // NO debe lanzar (si lanzara, el handler relanzaría → kafkajs reintenta → poison infinito).
    const outcome = await repo.confirmAndLockSeats(booking, uuidv7());
    expect(outcome.kind).toBe('OFFER_UNAVAILABLE');

    // El booking se canceló; la oferta NO se tocó (su contador queda intacto: nunca decrementamos sobre no-reservable).
    expect((await getBooking(bookingId)).estado).toBe(BookingState.CANCELADO);
    const trip = await getTrip(tripId);
    expect(trip.asientosDisponibles).toBe(3); // intacto.
    expect(trip.estado).toBe(PublishedTripState.CANCELADO); // sin re-transición.

    // booking.cancelled(OFERTA_NO_DISPONIBLE) emitido al outbox (Refund lo hará F3c-payment, hubo captura).
    const evts = await cancelledOutbox(bookingId);
    expect(evts).toHaveLength(1);
    const payload = evts[0]?.envelope as { payload?: { razon?: string } };
    expect(payload.payload?.razon).toBe('OFERTA_NO_DISPONIBLE');
  });

  it('GUARD F3c idempotente: 2ª captura sobre oferta no-reservable (booking ya CANCELADO) → NOOP, sin doble-evento', async () => {
    const tripId = await seedTrip(3);
    const bookingId = await seedPendingBooking(tripId, 1);
    await prisma.publishedTrip.update({
      where: { id: tripId },
      data: { estado: PublishedTripState.CANCELADO },
    });

    const first = await repo.confirmAndLockSeats(await getBooking(bookingId), uuidv7());
    expect(first.kind).toBe('OFFER_UNAVAILABLE');

    // 2ª corrida con el MISMO booking (ya CANCELADO): el where atómico `estado: COBRO_PENDIENTE` no matchea → NOOP.
    const second = await repo.confirmAndLockSeats(await getBooking(bookingId), uuidv7());
    expect(second.kind).toBe('NOOP');
    expect(await cancelledOutbox(bookingId)).toHaveLength(1); // un solo evento, sin duplicar.
  });

  it('multi-asiento concurrente: 2 bookings de 2 asientos sobre 3 disponibles → 1 confirma (disp=1), 1 ASIENTO_LLENO', async () => {
    const tripId = await seedTrip(3);
    const a = await seedPendingBooking(tripId, 2);
    const b = await seedPendingBooking(tripId, 2);

    const [ra, rb] = await Promise.all(
      [a, b].map(async (id) => {
        const booking = await prisma.booking.findUniqueOrThrow({ where: { id } });
        return repo.confirmAndLockSeats(booking, uuidv7());
      }),
    );

    const kinds = [ra, rb].map((o) => o.kind).sort();
    expect(kinds).toEqual(['CONFIRMED', 'SEAT_FULL']); // uno toma 2 (queda 1, no alcanza para el otro de 2).
    const trip = await getTrip(tripId);
    expect(trip.asientosDisponibles).toBe(1); // 3 - 2 = 1; el segundo (2 > 1) no decrementa.
    expect(trip.asientosDisponibles).toBeGreaterThanOrEqual(0); // nunca oversold.
    expect(trip.estado).toBe(PublishedTripState.PARCIALMENTE_RESERVADO);
  });
});
