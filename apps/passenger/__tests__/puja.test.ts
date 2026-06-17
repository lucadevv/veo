import type {
  CancelTripRequest,
  CreatedShareLink,
  CreateTripRequest,
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
import {HttpTripRepository} from '../src/features/trip/data/httpTripRepository';
import type {TripRepository} from '../src/features/trip/domain/tripRepository';
import {
  AcceptOfferUseCase,
  CancelBidUseCase,
  ListOffersUseCase,
  RebidUseCase,
  TripValidationError,
} from '../src/features/trip/domain/usecases';

const OFFER: OfferView = {
  tripId: 'trip-1',
  driverId: 'drv-1',
  kind: 'ACCEPT_PRICE',
  priceCents: 1500,
  etaSeconds: 240,
  status: 'PENDING',
};

function fakeTrip(): TripResource {
  return {id: 'trip-1', status: 'REQUESTED'} as TripResource;
}

/** TripRepository falso: las pujas devuelven datos; el resto es no-op suficiente para tipar. */
class FakeTripRepository implements TripRepository {
  listOffers = jest.fn(async (_id: string): Promise<OfferList> => [OFFER]);
  acceptOffer = jest.fn(
    async (_id: string, _d: string): Promise<OfferView> => OFFER,
  );
  cancelBid = jest.fn(async (_id: string): Promise<void> => undefined);
  rebid = jest.fn(
    async (_id: string, _b: number): Promise<TripResource> => fakeTrip(),
  );
  getSurge = jest.fn(
    async (_c: GeoPoint): Promise<SurgeQuote> => ({
      multiplier: 1,
      zoneId: 'z',
      active: false,
    }),
  );
  createTrip = jest.fn(
    async (_i: CreateTripRequest): Promise<TripResource> => fakeTrip(),
  );
  getActiveTrip = jest.fn(
    async (_id: string): Promise<TripActiveView> => ({}) as TripActiveView,
  );
  getTripState = jest.fn(
    async (_id: string): Promise<TripStateView> => ({
      id: 'x',
      status: 'REQUESTED',
    }),
  );
  cancelTrip = jest.fn(
    async (_id: string, _i: CancelTripRequest): Promise<TripResource> =>
      fakeTrip(),
  );
  changeDestination = jest.fn(
    async (_id: string, _d: GeoPoint): Promise<TripResource> => fakeTrip(),
  );
  getVideoGrant = jest.fn(
    async (_id: string): Promise<TripVideoGrant> => ({url: 'u', token: 't'}),
  );
  shareTrip = jest.fn(
    async (_id: string, _i?: ShareTripRequest): Promise<CreatedShareLink> =>
      ({}) as CreatedShareLink,
  );
  listScheduledTrips = jest.fn(async (): Promise<ScheduledTripList> => []);
  cancelScheduledTrip = jest.fn(
    async (_id: string): Promise<void> => undefined,
  );
}

describe('PUJA · usecases', () => {
  it('ListOffersUseCase lista las ofertas del board del viaje', async () => {
    const repo = new FakeTripRepository();
    const offers = await new ListOffersUseCase(repo).execute('trip-1');
    expect(repo.listOffers).toHaveBeenCalledWith('trip-1');
    expect(offers).toHaveLength(1);
    expect(offers[0]!.kind).toBe('ACCEPT_PRICE');
  });

  it('AcceptOfferUseCase elige la oferta por driverId (no por un bidId)', async () => {
    const repo = new FakeTripRepository();
    await new AcceptOfferUseCase(repo).execute('trip-1', 'drv-1');
    expect(repo.acceptOffer).toHaveBeenCalledWith('trip-1', 'drv-1');
  });

  it('CancelBidUseCase cancela la puja del viaje', async () => {
    const repo = new FakeTripRepository();
    await new CancelBidUseCase(repo).execute('trip-1');
    expect(repo.cancelBid).toHaveBeenCalledWith('trip-1');
  });

  it('RebidUseCase re-puja con un monto válido', async () => {
    const repo = new FakeTripRepository();
    await new RebidUseCase(repo).execute('trip-1', 1600);
    expect(repo.rebid).toHaveBeenCalledWith('trip-1', 1600);
  });

  it('RebidUseCase RECHAZA un monto ≤ 0 o no-entero (no llama al repo)', () => {
    const repo = new FakeTripRepository();
    const useCase = new RebidUseCase(repo);
    expect(() => useCase.execute('trip-1', 0)).toThrow(TripValidationError);
    expect(() => useCase.execute('trip-1', -100)).toThrow(TripValidationError);
    expect(() => useCase.execute('trip-1', 12.5)).toThrow(TripValidationError);
    expect(repo.rebid).not.toHaveBeenCalled();
  });
});

describe('PUJA · HttpTripRepository (endpoints reales del BFF)', () => {
  it('listOffers → GET /trips/:id/offers', async () => {
    const get = jest.fn(async () => [OFFER]);
    const repo = new HttpTripRepository({get} as unknown as HttpClient);
    await repo.listOffers('trip-1');
    expect(get).toHaveBeenCalledWith('/trips/trip-1/offers', {
      schema: expect.anything(),
    });
  });

  it('acceptOffer → POST /trips/:id/offers/:driverId/accept (por driverId)', async () => {
    const post = jest.fn(async () => OFFER);
    const repo = new HttpTripRepository({post} as unknown as HttpClient);
    await repo.acceptOffer('trip-1', 'drv-9');
    expect(post).toHaveBeenCalledWith('/trips/trip-1/offers/drv-9/accept', {
      body: {},
      schema: expect.anything(),
    });
  });

  it('cancelBid → POST /trips/:id/bid/cancel (sin schema, body vacío)', async () => {
    const post = jest.fn(async () => ({ok: true}));
    const repo = new HttpTripRepository({post} as unknown as HttpClient);
    await repo.cancelBid('trip-1');
    expect(post).toHaveBeenCalledWith('/trips/trip-1/bid/cancel', {body: {}});
  });

  it('rebid → POST /trips/:id/rebid con { bidCents }', async () => {
    const post = jest.fn(async () => fakeTrip());
    const repo = new HttpTripRepository({post} as unknown as HttpClient);
    await repo.rebid('trip-1', 1800);
    expect(post).toHaveBeenCalledWith('/trips/trip-1/rebid', {
      body: {bidCents: 1800},
      schema: expect.anything(),
    });
  });
});
