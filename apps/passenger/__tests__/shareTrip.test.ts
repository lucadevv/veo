import type {
  CancelTripRequest,
  CreateTripRequest,
  CreatedShareLink,
  GeoPoint,
  HttpClient,
  OfferList,
  OfferView,
  ScheduledTripList,
  ShareTripRequest,
  SurgeQuote,
  TripActiveView,
  TripResource,
  TripStateView,
  TripVideoGrant,
} from '@veo/api-client';
import { HttpTripRepository } from '../src/features/trip/data/httpTripRepository';
import type { TripRepository } from '../src/features/trip/domain/tripRepository';
import { ShareTripUseCase } from '../src/features/trip/domain/usecases';

const SHARE_LINK: CreatedShareLink = {
  shareId: 'share-1',
  token: 'tok_abc',
  url: 'https://veo.pe/t/tok_abc',
  tripId: 'trip-1',
  contactId: null,
  expiresAt: '2026-05-31T12:00:00.000Z',
  maxUses: 50,
};

/** TripRepository mínimo que solo implementa `shareTrip`; el resto lanza si se invoca por error. */
class FakeTripRepository implements TripRepository {
  shareTrip = jest.fn(
    async (_id: string, _input?: ShareTripRequest): Promise<CreatedShareLink> => SHARE_LINK,
  );
  getSurge = jest.fn(async (_c: GeoPoint): Promise<SurgeQuote> => ({ multiplier: 1, zoneId: 'z', active: false }));
  createTrip = jest.fn(async (_input: CreateTripRequest): Promise<TripResource> => ({} as TripResource));
  getActiveTrip = jest.fn(async (_id: string): Promise<TripActiveView> => ({} as TripActiveView));
  getTripState = jest.fn(async (_id: string): Promise<TripStateView> => ({ id: 'x', status: 'REQUESTED' }));
  cancelTrip = jest.fn(async (_id: string, _i: CancelTripRequest): Promise<TripResource> => ({} as TripResource));
  changeDestination = jest.fn(async (_id: string, _d: GeoPoint): Promise<TripResource> => ({} as TripResource));
  getVideoGrant = jest.fn(async (_id: string): Promise<TripVideoGrant> => ({ url: 'u', token: 't' }));
  listScheduledTrips = jest.fn(async (): Promise<ScheduledTripList> => []);
  cancelScheduledTrip = jest.fn(async (_id: string): Promise<void> => undefined);
  listOffers = jest.fn(async (_id: string): Promise<OfferList> => []);
  acceptOffer = jest.fn(
    async (_id: string, _d: string): Promise<OfferView> => ({} as OfferView),
  );
  cancelBid = jest.fn(async (_id: string): Promise<void> => undefined);
  rebid = jest.fn(async (_id: string, _b: number): Promise<TripResource> => ({} as TripResource));
}

describe('ShareTripUseCase', () => {
  it('crea el enlace público y devuelve la URL para compartir', async () => {
    const repo = new FakeTripRepository();
    const useCase = new ShareTripUseCase(repo);

    const link = await useCase.execute('trip-1');

    expect(repo.shareTrip).toHaveBeenCalledWith('trip-1', undefined);
    expect(link.url).toBe(SHARE_LINK.url);
    expect(link.token).toBe(SHARE_LINK.token);
  });

  it('reenvía las opciones del request (contacto / TTL / máximo de aperturas)', async () => {
    const repo = new FakeTripRepository();
    const useCase = new ShareTripUseCase(repo);
    const input: ShareTripRequest = {
      contactId: '11111111-1111-1111-1111-111111111111',
      ttlSeconds: 3600,
      maxUses: 5,
    };

    await useCase.execute('trip-1', input);

    expect(repo.shareTrip).toHaveBeenCalledWith('trip-1', input);
  });

  it('propaga el error del repositorio (red/bff) sin tragárselo', async () => {
    const repo = new FakeTripRepository();
    repo.shareTrip.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    const useCase = new ShareTripUseCase(repo);

    await expect(useCase.execute('trip-1')).rejects.toThrow(/503/);
  });
});

describe('HttpTripRepository.shareTrip', () => {
  it('hace POST /share/:tripId con el body y valida la respuesta con el schema', async () => {
    const post = jest.fn(async () => SHARE_LINK);
    const http = { post } as unknown as HttpClient;
    const repository = new HttpTripRepository(http);

    const link = await repository.shareTrip('trip-1', { maxUses: 10 });

    expect(post).toHaveBeenCalledWith('/share/trip-1', {
      body: { maxUses: 10 },
      schema: expect.anything(),
    });
    expect(link).toEqual(SHARE_LINK);
  });

  it('envía un body vacío cuando no se pasan opciones (defaults del bff)', async () => {
    const post = jest.fn(async () => SHARE_LINK);
    const http = { post } as unknown as HttpClient;
    const repository = new HttpTripRepository(http);

    await repository.shareTrip('trip-1');

    expect(post).toHaveBeenCalledWith('/share/trip-1', {
      body: {},
      schema: expect.anything(),
    });
  });

  it('propaga el error de red del HttpClient', async () => {
    const post = jest.fn(async () => {
      throw new Error('network down');
    });
    const http = { post } as unknown as HttpClient;
    const repository = new HttpTripRepository(http);

    await expect(repository.shareTrip('trip-1')).rejects.toThrow(/network down/);
  });
});
