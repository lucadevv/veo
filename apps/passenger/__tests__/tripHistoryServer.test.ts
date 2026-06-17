import type {
  HttpClient,
  TripHistoryItem,
  TripHistoryPage,
} from '@veo/api-client';
import {HttpTripRepository} from '../src/features/trip/data/httpTripRepository';
import {GetTripHistoryUseCase} from '../src/features/trip/domain/usecases';
import {
  isLiveTrip,
  isTerminalTrip,
} from '../src/features/trip/domain/tripStatusClass';

/** Fake mínimo del HttpClient con los cuatro verbos. */
function fakeHttp(overrides: Partial<HttpClient>): HttpClient {
  return {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
    ...overrides,
  } as unknown as HttpClient;
}

/** Item del historial del server (estados REALES), factory mínima. */
function item(id: string, status: TripHistoryItem['status']): TripHistoryItem {
  return {
    id,
    status,
    origin: {lat: -12.04, lng: -77.04},
    destination: {lat: -12.1, lng: -77.0},
    fareCents: 1500,
    currency: 'PEN',
    paymentMethod: 'YAPE',
    distanceMeters: 3200,
    durationSeconds: 540,
    requestedAt: '2026-06-01T10:00:00.000Z',
    completedAt: status === 'COMPLETED' ? '2026-06-01T10:30:00.000Z' : null,
    cancelledAt: status === 'CANCELLED' ? '2026-06-01T10:05:00.000Z' : null,
    driverId: status === 'COMPLETED' ? 'd-1' : null,
    vehicleType: 'CAR',
    category: null,
  };
}

describe('HttpTripRepository · getTripHistory (GET /trips/history, cursor)', () => {
  it('pega a /trips/history pasando cursor+limit y devuelve la página { items, nextCursor }', async () => {
    const page: TripHistoryPage = {
      items: [item('t-1', 'COMPLETED'), item('t-2', 'CANCELLED')],
      nextCursor: 'opaque-cursor-2',
    };
    const get = jest.fn(async () => page);
    const repo = new HttpTripRepository(fakeHttp({get}));

    const result = await repo.getTripHistory({
      cursor: 'opaque-cursor-1',
      limit: 20,
    });

    expect(get).toHaveBeenCalledTimes(1);
    const [path, opts] = get.mock.calls[0] as [
      string,
      {query?: Record<string, unknown>},
    ];
    expect(path).toBe('/trips/history');
    // El helper del api-client arma la query con el cursor opaco y el límite.
    expect(opts.query).toMatchObject({cursor: 'opaque-cursor-1', limit: 20});
    expect(result.items.map(i => i.id)).toEqual(['t-1', 't-2']);
    expect(result.nextCursor).toBe('opaque-cursor-2');
  });

  it('primera página sin cursor → no manda cursor; nextCursor null corta la paginación', async () => {
    const lastPage: TripHistoryPage = {
      items: [item('t-9', 'EXPIRED')],
      nextCursor: null,
    };
    const get = jest.fn(async () => lastPage);
    const repo = new HttpTripRepository(fakeHttp({get}));

    const result = await repo.getTripHistory();

    const [, opts] = get.mock.calls[0] as [
      string,
      {query?: Record<string, unknown>},
    ];
    expect(opts.query?.cursor).toBeUndefined();
    // nextCursor null ⇒ el consumidor (useInfiniteQuery) no pide otra página.
    expect(result.nextCursor).toBeNull();
  });
});

describe('GetTripHistoryUseCase · pasa la query y devuelve la página tal cual', () => {
  it('delega en el repositorio sin transformar', async () => {
    const page: TripHistoryPage = {
      items: [item('t-1', 'COMPLETED')],
      nextCursor: null,
    };
    const repo = {getTripHistory: jest.fn(async () => page)};
    const usecase = new GetTripHistoryUseCase(repo as never);

    await expect(usecase.execute({cursor: 'c', limit: 10})).resolves.toEqual(
      page,
    );
    expect(repo.getTripHistory).toHaveBeenCalledWith({cursor: 'c', limit: 10});
  });
});

describe('Clasificación de estado para la navegación (cierra el bug de la legacy)', () => {
  it('los terminales abren el DETALLE (no son "vivos")', () => {
    for (const status of [
      'COMPLETED',
      'CANCELLED',
      'EXPIRED',
      'FAILED',
    ] as const) {
      expect(isTerminalTrip(status)).toBe(true);
      expect(isLiveTrip(status)).toBe(false);
    }
  });

  it('los no terminales son VIVOS → se re-entran por el sheet, nunca por TripActive', () => {
    for (const status of [
      'REQUESTED',
      'MATCHING',
      'ASSIGNED',
      'ACCEPTED',
      'ARRIVING',
      'ARRIVED',
      'IN_PROGRESS',
      'REASSIGNING',
      'SCHEDULED',
    ] as const) {
      expect(isLiveTrip(status)).toBe(true);
      expect(isTerminalTrip(status)).toBe(false);
    }
  });
});
