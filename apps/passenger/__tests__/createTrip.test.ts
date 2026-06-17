import type {
  CancelTripRequest,
  CreateTripRequest,
  GeoPoint,
  OfferList,
  OfferView,
  ScheduledTripList,
  SurgeQuote,
  TripActiveView,
  TripResource,
  TripStateView,
  TripVideoGrant,
} from '@veo/api-client';
import {
  CreateTripUseCase,
  TripValidationError,
} from '../src/features/trip/domain/usecases';
import type {TripRepository} from '../src/features/trip/domain/tripRepository';

const LIMA_ORIGIN: GeoPoint = {lat: -12.046, lon: -77.0428};
const LIMA_DESTINATION: GeoPoint = {lat: -12.1, lon: -77.0};
const OUTSIDE: GeoPoint = {lat: 0, lon: 0};

function fakeTrip(): TripResource {
  return {
    id: 'trip-1',
    passengerId: 'pax-1',
    driverId: null,
    vehicleId: null,
    status: 'REQUESTED',
    origin: LIMA_ORIGIN,
    destination: LIMA_DESTINATION,
    fareCents: 1500,
    currency: 'PEN',
    surgeMultiplier: 1,
    distanceMeters: 5000,
    durationSeconds: 600,
    paymentMethod: 'CASH',
    routePolyline: null,
    waypoints: [],
    vehicleType: 'CAR',
    scheduledFor: null,
    category: null,
    childMode: false,
    penaltyCents: 0,
    requestedAt: '2026-05-29T10:00:00.000Z',
    completedAt: null,
    cancelledAt: null,
  };
}

class FakeTripRepository implements TripRepository {
  createTrip = jest.fn(async (_input: CreateTripRequest) => fakeTrip());
  getSurge = jest.fn(
    async (_c: GeoPoint): Promise<SurgeQuote> => ({
      multiplier: 1,
      zoneId: 'z',
      active: false,
    }),
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
  cancelTrip = jest.fn(async (_id: string, _i: CancelTripRequest) =>
    fakeTrip(),
  );
  changeDestination = jest.fn(async (_id: string, _d: GeoPoint) => fakeTrip());
  getVideoGrant = jest.fn(
    async (_id: string): Promise<TripVideoGrant> => ({url: 'u', token: 't'}),
  );
  listScheduledTrips = jest.fn(async (): Promise<ScheduledTripList> => []);
  cancelScheduledTrip = jest.fn(
    async (_id: string): Promise<void> => undefined,
  );
  listOffers = jest.fn(async (_id: string): Promise<OfferList> => []);
  acceptOffer = jest.fn(
    async (_id: string, _d: string): Promise<OfferView> => ({
      tripId: 'trip-1',
      driverId: 'drv-1',
      kind: 'ACCEPT_PRICE',
      priceCents: 1500,
      etaSeconds: 240,
      status: 'PENDING',
    }),
  );
  cancelBid = jest.fn(async (_id: string): Promise<void> => undefined);
  rebid = jest.fn(async (_id: string, _b: number) => fakeTrip());
}

describe('CreateTripUseCase', () => {
  it('crea el viaje cuando origen y destino están en Lima', async () => {
    const repo = new FakeTripRepository();
    const useCase = new CreateTripUseCase(repo);

    await useCase.execute({
      origin: LIMA_ORIGIN,
      destination: LIMA_DESTINATION,
      paymentMethod: 'CASH',
    });

    expect(repo.createTrip).toHaveBeenCalledTimes(1);
  });

  it('rechaza si algún punto está fuera de Lima (no llama al repo)', () => {
    const repo = new FakeTripRepository();
    const useCase = new CreateTripUseCase(repo);

    expect(() =>
      useCase.execute({
        origin: LIMA_ORIGIN,
        destination: OUTSIDE,
        paymentMethod: 'CASH',
      }),
    ).toThrow(TripValidationError);
    expect(repo.createTrip).not.toHaveBeenCalled();
  });

  it('rechaza un código de modo niño inválido', () => {
    const repo = new FakeTripRepository();
    const useCase = new CreateTripUseCase(repo);

    expect(() =>
      useCase.execute({
        origin: LIMA_ORIGIN,
        destination: LIMA_DESTINATION,
        paymentMethod: 'CASH',
        childMode: true,
        childCode: '12',
      }),
    ).toThrow(/niño/i);
    expect(repo.createTrip).not.toHaveBeenCalled();
  });

  it('reenvía paradas intermedias y el tipo de vehículo de la opción elegida', async () => {
    const repo = new FakeTripRepository();
    const useCase = new CreateTripUseCase(repo);
    const waypoints: GeoPoint[] = [{lat: -12.06, lon: -77.03}];

    await useCase.execute({
      origin: LIMA_ORIGIN,
      destination: LIMA_DESTINATION,
      paymentMethod: 'YAPE',
      waypoints,
      vehicleType: 'MOTO',
      category: 'veo_moto',
    });

    expect(repo.createTrip).toHaveBeenCalledWith(
      expect.objectContaining({
        waypoints,
        vehicleType: 'MOTO',
        category: 'veo_moto',
      }),
      undefined, // IK · sin key explícita en este caso
    );
  });

  it('rechaza si una parada cae fuera de Lima (no llama al repo)', () => {
    const repo = new FakeTripRepository();
    const useCase = new CreateTripUseCase(repo);

    expect(() =>
      useCase.execute({
        origin: LIMA_ORIGIN,
        destination: LIMA_DESTINATION,
        paymentMethod: 'CASH',
        waypoints: [OUTSIDE],
      }),
    ).toThrow(TripValidationError);
    expect(repo.createTrip).not.toHaveBeenCalled();
  });

  it('crea un viaje programado con fecha válida (dentro de la ventana)', async () => {
    const repo = new FakeTripRepository();
    const useCase = new CreateTripUseCase(repo);
    const scheduledFor = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await useCase.execute({
      origin: LIMA_ORIGIN,
      destination: LIMA_DESTINATION,
      paymentMethod: 'CASH',
      scheduledFor,
    });

    expect(repo.createTrip).toHaveBeenCalledWith(
      expect.objectContaining({scheduledFor}),
      undefined,
    );
  });

  it('IK · propaga la idempotency key al repositorio (reintento = mismo viaje, no dos boards)', async () => {
    const repo = new FakeTripRepository();
    const useCase = new CreateTripUseCase(repo);
    await useCase.execute(
      {
        origin: LIMA_ORIGIN,
        destination: LIMA_DESTINATION,
        paymentMethod: 'CASH',
      },
      'intent-key-1',
    );
    expect(repo.createTrip).toHaveBeenCalledWith(
      expect.anything(),
      'intent-key-1',
    );
  });

  it('rechaza programar con menos de 15 minutos de anticipación', () => {
    const repo = new FakeTripRepository();
    const useCase = new CreateTripUseCase(repo);
    const tooSoon = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    expect(() =>
      useCase.execute({
        origin: LIMA_ORIGIN,
        destination: LIMA_DESTINATION,
        paymentMethod: 'CASH',
        scheduledFor: tooSoon,
      }),
    ).toThrow(TripValidationError);
    expect(repo.createTrip).not.toHaveBeenCalled();
  });
});
