import type {HttpClient} from '@veo/api-client';
import type {ZodType} from 'zod';
import {HttpCarpoolRepository} from './httpCarpoolRepository';

/** Doble mínimo de HttpClient: solo los verbos que usa el repo de carpooling. */
function makeHttp(overrides: Partial<HttpClient>): HttpClient {
  return {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    ...overrides,
  } as unknown as HttpClient;
}

/**
 * Mock de verbo HTTP que PARSEA la fixture con el schema zod que el repo le pasa (como hace el
 * HttpClient real): si la fixture no calza el contrato de `@veo/api-client`, el test truena acá.
 */
function verbWithParse(raw: unknown): jest.Mock {
  return jest.fn((_path: string, opts?: {schema?: ZodType<unknown>}) =>
    Promise.resolve(opts?.schema ? opts.schema.parse(raw) : raw),
  );
}

/** Viaje público mínimo válido según `carpoolTripPublicView` (fixture compartida). */
const TRIP_PUBLIC = {
  id: '7b40c9a2-6f1e-4c7a-9d55-2f9f6b1c3a10',
  origenLat: -12.0464,
  origenLon: -77.0428,
  destinoLat: -9.5278,
  destinoLon: -77.5278,
  stopovers: [{lat: -10.75, lon: -77.76, orden: 1}],
  fechaHoraSalida: '2026-07-10T08:30:00.000Z',
  asientosTotales: 4,
  asientosDisponibles: 3,
  pricingMode: 'FIJO',
  precioBase: 3500,
  precioPorTramo: [],
  modoReserva: 'REVISION_CADA_SOLICITUD',
  reglas: 'No fumar',
  pais: 'PE',
  moneda: 'PEN',
  estado: 'PUBLICADO',
};

/** MI reserva mínima válida según `carpoolBookingView` (Booking serializado). */
const BOOKING = {
  id: '3f1b2a9c-8d4e-4f6a-b7c1-0a2d4e6f8b90',
  publishedTripId: TRIP_PUBLIC.id,
  passengerId: 'c2a1e0d9-4b3f-4a5c-8d7e-6f5a4b3c2d1e',
  asientos: 2,
  pickupLat: -12.0464,
  pickupLon: -77.0428,
  dropoffLat: -9.5278,
  dropoffLon: -77.5278,
  precioAcordado: 3500,
  mensajeIntro: 'Hola, viajo con poco equipaje',
  specialRequest: null,
  paymentMethod: 'YAPE',
  paymentId: null,
  estado: 'PENDIENTE_APROBACION',
  createdAt: '2026-07-03T15:00:00.000Z',
  updatedAt: '2026-07-03T15:00:00.000Z',
};

describe('HttpCarpoolRepository · búsqueda', () => {
  it('searchTrips pega a GET /carpool/trips/search con los params y el schema de página', async () => {
    const get = verbWithParse({
      items: [{trip: TRIP_PUBLIC, driver: null}],
      nextCursor: null,
    });
    const repo = new HttpCarpoolRepository(makeHttp({get}));

    const page = await repo.searchTrips({
      originLat: -12.0464,
      originLon: -77.0428,
      destLat: -9.5278,
      destLon: -77.5278,
      fecha: '2026-07-10',
      asientos: 1,
      limit: 20,
    });

    // El item llega con driver null (degradación honesta) y el envelope keyset intacto.
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.driver).toBeNull();
    expect(page.nextCursor).toBeNull();
    expect(get).toHaveBeenCalledWith(
      '/carpool/trips/search',
      expect.objectContaining({
        query: expect.objectContaining({
          originLat: -12.0464,
          destLon: -77.5278,
          fecha: '2026-07-10',
          asientos: 1,
          limit: 20,
          // Sin cursor en la primera página: viaja undefined y el HttpClient lo omite del query.
          cursor: undefined,
        }),
        schema: expect.anything(),
      }),
    );
  });

  it('getTripDetail pega a GET /carpool/trips/:id y devuelve driver+vehicle cuando llegan', async () => {
    const get = verbWithParse({
      trip: TRIP_PUBLIC,
      driver: {id: 'd-1', name: 'Carlos M.', averageRating: 4.9},
      vehicle: {
        id: 'v-1',
        make: 'Toyota',
        model: 'Corolla',
        color: 'Gris',
        plate: 'ABC-123',
        vehicleType: 'SEDAN',
      },
    });
    const repo = new HttpCarpoolRepository(makeHttp({get}));

    const detail = await repo.getTripDetail(TRIP_PUBLIC.id);

    expect(detail.driver?.name).toBe('Carlos M.');
    expect(detail.vehicle?.plate).toBe('ABC-123');
    expect(get).toHaveBeenCalledWith(
      `/carpool/trips/${TRIP_PUBLIC.id}`,
      expect.objectContaining({schema: expect.anything()}),
    );
  });
});

describe('HttpCarpoolRepository · reserva', () => {
  it('reserve pega a POST /carpool/bookings con el body y la Idempotency-Key del submit', async () => {
    const post = verbWithParse(BOOKING);
    const repo = new HttpCarpoolRepository(makeHttp({post}));

    const request = {
      publishedTripId: TRIP_PUBLIC.id,
      asientos: 2,
      paymentMethod: 'YAPE' as const,
      pickupLat: -12.0464,
      pickupLon: -77.0428,
      dropoffLat: -9.5278,
      dropoffLon: -77.5278,
      mensajeIntro: 'Hola, viajo con poco equipaje',
    };

    const booking = await repo.reserve(request, 'ik-uuid-1');

    expect(booking.estado).toBe('PENDIENTE_APROBACION');
    expect(post).toHaveBeenCalledWith(
      '/carpool/bookings',
      expect.objectContaining({
        body: request,
        idempotencyKey: 'ik-uuid-1',
        schema: expect.anything(),
      }),
    );
  });

  it('getBooking pega a GET /carpool/bookings/:id (el poll del estado usa este camino)', async () => {
    const get = verbWithParse({...BOOKING, estado: 'CONFIRMADO'});
    const repo = new HttpCarpoolRepository(makeHttp({get}));

    const booking = await repo.getBooking(BOOKING.id);

    expect(booking.estado).toBe('CONFIRMADO');
    expect(get).toHaveBeenCalledWith(
      `/carpool/bookings/${BOOKING.id}`,
      expect.objectContaining({schema: expect.anything()}),
    );
  });
});
