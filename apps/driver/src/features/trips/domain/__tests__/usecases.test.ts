import type { RespondWaypointView, TripHistoryPage } from '@veo/api-client';
import type {
  AcceptTripInput,
  ArrivingTripInput,
  CancelTripInput,
  CommissionRateView,
  StartTripInput,
  Trip,
  TripOffer,
  TripRouteView,
  TripsRepository,
  TripState,
} from '../index';
import {
  ConfirmTripCashUseCase,
  EnsureTripAcceptedUseCase,
  GetActiveTripUseCase,
  InvalidChildCodeError,
  StartTripUseCase,
} from '../index';

const TRIP: Trip = {
  id: 't1',
  passengerId: 'p1',
  driverId: 'd1',
  vehicleId: 'v1',
  status: 'IN_PROGRESS',
  fareCents: 1500,
  currency: 'PEN',
  distanceMeters: 3200,
  durationSeconds: 600,
  paymentMethod: 'CASH',
  childMode: true,
  penaltyCents: 0,
  passengerFirstName: null,
};

/** Doble de prueba del repositorio de viajes (no es un mock de producción). */
class FakeTripsRepository implements TripsRepository {
  startCalls: Array<{ tripId: string; input: StartTripInput }> = [];
  confirmCashCalls: Array<{ tripId: string; collected: boolean }> = [];

  getOffer(): Promise<TripOffer> {
    throw new Error('no usado');
  }
  acceptOffer(): Promise<void> {
    return Promise.resolve();
  }
  rejectOffer(): Promise<void> {
    return Promise.resolve();
  }
  getTrip(): Promise<Trip> {
    return Promise.resolve(TRIP);
  }
  getActiveTrip(): Promise<Trip | null> {
    return Promise.resolve(TRIP);
  }
  getTripState(): Promise<TripState> {
    return Promise.resolve({ id: 't1', status: 'IN_PROGRESS' });
  }
  getTripHistory(): Promise<TripHistoryPage> {
    return Promise.resolve({ items: [], nextCursor: null });
  }
  getRoute(): Promise<TripRouteView> {
    return Promise.resolve({
      polyline: '',
      distanceMeters: 0,
      durationSeconds: 0,
      steps: [],
      origin: { lat: 0, lon: 0 },
      destination: { lat: 0, lon: 0 },
      waypoints: [],
    });
  }
  accept(_tripId: string, _input: AcceptTripInput): Promise<Trip> {
    return Promise.resolve(TRIP);
  }
  arriving(_tripId: string, _input: ArrivingTripInput): Promise<Trip> {
    return Promise.resolve(TRIP);
  }
  arrived(): Promise<Trip> {
    return Promise.resolve(TRIP);
  }
  start(tripId: string, input: StartTripInput): Promise<Trip> {
    this.startCalls.push({ tripId, input });
    return Promise.resolve(TRIP);
  }
  complete(): Promise<Trip> {
    return Promise.resolve(TRIP);
  }
  cancel(_tripId: string, _input: CancelTripInput): Promise<Trip> {
    return Promise.resolve(TRIP);
  }
  confirmCash(tripId: string, collected: boolean): Promise<void> {
    this.confirmCashCalls.push({ tripId, collected });
    return Promise.resolve();
  }
  respondWaypoint(
    _tripId: string,
    proposalId: string,
    accept: boolean,
  ): Promise<RespondWaypointView> {
    return Promise.resolve({
      proposalId,
      status: accept ? 'ACCEPTED' : 'REJECTED',
      fareCents: 0,
    });
  }
  getCommissionRate(): Promise<CommissionRateView> {
    return Promise.resolve({ onDemandRateBps: 2000, version: 1 });
  }
}

describe('StartTripUseCase (modo niño)', () => {
  it('lanza error si el código no tiene 4 a 6 dígitos', async () => {
    const repo = new FakeTripsRepository();
    await expect(() => new StartTripUseCase(repo).execute('t1', '12')).toThrow(
      InvalidChildCodeError,
    );
    await expect(() => new StartTripUseCase(repo).execute('t1', 'abcd')).toThrow(
      InvalidChildCodeError,
    );
    expect(repo.startCalls).toHaveLength(0);
  });

  it('acepta código válido y lo reenvía al repositorio', async () => {
    const repo = new FakeTripsRepository();
    await new StartTripUseCase(repo).execute('t1', '1234');
    expect(repo.startCalls[0]).toEqual({ tripId: 't1', input: { childCode: '1234' } });
  });

  it('permite iniciar sin código (viaje normal)', async () => {
    const repo = new FakeTripsRepository();
    await new StartTripUseCase(repo).execute('t1');
    expect(repo.startCalls[0]).toEqual({ tripId: 't1', input: { childCode: undefined } });
  });
});

describe('ConfirmTripCashUseCase (cobro en efectivo)', () => {
  it('reenvía collected=true al repositorio (cobro confirmado)', async () => {
    const repo = new FakeTripsRepository();
    await new ConfirmTripCashUseCase(repo).execute('t1', true);
    expect(repo.confirmCashCalls).toEqual([{ tripId: 't1', collected: true }]);
  });

  it('reenvía collected=false al repositorio (reporta que no cobró)', async () => {
    const repo = new FakeTripsRepository();
    await new ConfirmTripCashUseCase(repo).execute('t1', false);
    expect(repo.confirmCashCalls).toEqual([{ tripId: 't1', collected: false }]);
  });
});

describe('GetActiveTripUseCase (rehidratación)', () => {
  it('devuelve el viaje activo del conductor cuando hay uno en curso', async () => {
    const repo = new FakeTripsRepository();
    const result = await new GetActiveTripUseCase(repo).execute();
    expect(result?.id).toBe('t1');
  });

  it('devuelve null cuando el conductor no tiene viaje activo', async () => {
    const repo = new FakeTripsRepository();
    repo.getActiveTrip = () => Promise.resolve(null);
    const result = await new GetActiveTripUseCase(repo).execute();
    expect(result).toBeNull();
  });
});

/** Repo configurable: secuencia de estados a devolver por getTripState + captura de accept. */
class ScriptedTripsRepository extends FakeTripsRepository {
  acceptCalls: Array<{ tripId: string; input: AcceptTripInput }> = [];
  private readonly states: string[];
  private cursor = 0;

  constructor(states: string[]) {
    super();
    this.states = states;
  }

  override getTripState(): Promise<TripState> {
    const status = this.states[Math.min(this.cursor, this.states.length - 1)] ?? 'MATCHING';
    this.cursor += 1;
    return Promise.resolve({ id: 't1', status });
  }

  override accept(tripId: string, input: AcceptTripInput): Promise<Trip> {
    this.acceptCalls.push({ tripId, input });
    return Promise.resolve({ ...TRIP, id: tripId, status: 'ACCEPTED' });
  }
}

describe('EnsureTripAcceptedUseCase (ASSIGNED→ACCEPTED robusto)', () => {
  const noSleep = () => Promise.resolve();

  it('acepta de inmediato si el viaje ya está ASSIGNED', async () => {
    const repo = new ScriptedTripsRepository(['ASSIGNED']);
    const result = await new EnsureTripAcceptedUseCase(repo, noSleep).execute('t1', {
      etaSeconds: 90,
    });

    expect(repo.acceptCalls).toEqual([{ tripId: 't1', input: { etaSeconds: 90 } }]);
    expect(result?.status).toBe('ACCEPTED');
  });

  it('espera (poll) a que el viaje pase de MATCHING a ASSIGNED antes de aceptar', async () => {
    let sleeps = 0;
    const repo = new ScriptedTripsRepository(['MATCHING', 'MATCHING', 'ASSIGNED']);
    const result = await new EnsureTripAcceptedUseCase(repo, async () => {
      sleeps += 1;
    }).execute('t1');

    expect(sleeps).toBe(2);
    expect(repo.acceptCalls).toHaveLength(1);
    expect(result?.status).toBe('ACCEPTED');
  });

  it('es idempotente: no acepta si el viaje ya está ACCEPTED', async () => {
    const repo = new ScriptedTripsRepository(['ACCEPTED']);
    const result = await new EnsureTripAcceptedUseCase(repo, noSleep).execute('t1');

    expect(repo.acceptCalls).toHaveLength(0);
    expect(result).toBeNull();
  });

  it('no se bloquea: agota los reintentos si nunca llega ASSIGNED y no acepta', async () => {
    const repo = new ScriptedTripsRepository(['MATCHING']);
    const result = await new EnsureTripAcceptedUseCase(repo, noSleep).execute('t1', {
      maxAttempts: 3,
    });

    expect(repo.acceptCalls).toHaveLength(0);
    expect(result).toBeNull();
  });
});
