import { ApiError, type HttpClient, type OfferList } from '@veo/api-client';
import { HttpTripRepository } from '../src/features/trip/data/httpTripRepository';
import { AcceptOfferUseCase, ListOffersUseCase } from '../src/features/trip/domain/usecases';

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

const TRIP_ID = 'trip-1';

const openBoard: OfferList = {
  board: { status: 'OPEN', expiresAt: 1_900_000_000_000 },
  offers: [
    {
      tripId: TRIP_ID,
      driverId: 'd-1',
      kind: 'ACCEPT_PRICE',
      priceCents: 1500,
      etaSeconds: 180,
      status: 'PENDING',
    },
  ],
};

describe('HttpTripRepository · listOffers (contrato nuevo { board, offers })', () => {
  it('pega a /trips/:id/offers con el schema offerList y devuelve el envelope { board, offers }', async () => {
    const get = jest.fn(async () => openBoard);
    const repo = new HttpTripRepository(fakeHttp({ get }));

    const result = await repo.listOffers(TRIP_ID);

    expect(get).toHaveBeenCalledTimes(1);
    const [path] = get.mock.calls[0] as [string, unknown];
    expect(path).toBe(`/trips/${TRIP_ID}/offers`);
    // El shape NUEVO: board (status/expiresAt) + offers (array), NO un OfferView[] pelado.
    expect(result.board.status).toBe('OPEN');
    expect(result.board.expiresAt).toBe(1_900_000_000_000);
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0].driverId).toBe('d-1');
  });

  it('un board CERRADO trae offers [] (nunca ofertas zombies de una puja muerta)', async () => {
    for (const status of ['CANCELLED', 'EXPIRED', 'CLOSED_MATCHED', 'GONE'] as const) {
      const closed: OfferList = {
        board: { status, expiresAt: status === 'GONE' ? null : 1_900_000_000_000 },
        offers: [],
      };
      const repo = new HttpTripRepository(fakeHttp({ get: jest.fn(async () => closed) }));

      const result = await repo.listOffers(TRIP_ID);

      expect(result.board.status).toBe(status);
      expect(result.offers).toEqual([]);
    }
  });
});

describe('ListOffersUseCase · pasa el envelope tal cual (la re-derivación vive en el hook)', () => {
  it('devuelve el { board, offers } del repositorio sin transformarlo', async () => {
    const repo = { listOffers: jest.fn(async () => openBoard) };
    const usecase = new ListOffersUseCase(repo as never);

    await expect(usecase.execute(TRIP_ID)).resolves.toEqual(openBoard);
    expect(repo.listOffers).toHaveBeenCalledWith(TRIP_ID);
  });
});

describe('AcceptOfferUseCase · oferta zombie (board cerrado) → el server responde 404/409', () => {
  it('propaga el ApiError 409 para que el hook refetchee el board nuevo (la verdad)', async () => {
    const repo = {
      acceptOffer: jest.fn(async () => {
        throw new ApiError(409, 'CONFLICT', 'board closed');
      }),
    };
    const usecase = new AcceptOfferUseCase(repo as never);

    await expect(usecase.execute(TRIP_ID, 'd-1')).rejects.toMatchObject({ status: 409 });
  });

  it('propaga el ApiError 404 (la oferta ya no existe) sin tragárselo', async () => {
    const repo = {
      acceptOffer: jest.fn(async () => {
        throw new ApiError(404, 'NOT_FOUND', 'offer gone');
      }),
    };
    const usecase = new AcceptOfferUseCase(repo as never);

    await expect(usecase.execute(TRIP_ID, 'd-1')).rejects.toMatchObject({ status: 404 });
  });
});
