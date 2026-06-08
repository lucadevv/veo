import { ApiError, type HttpClient, type PaymentView, type TripActiveView } from '@veo/api-client';
import { HttpPaymentsRepository } from '../src/features/payments/data/httpPaymentsRepository';
import { GetPaymentByTripUseCase } from '../src/features/payments/domain/usecases';
import { HttpTripRepository } from '../src/features/trip/data/httpTripRepository';
import {
  CloseTripUseCase,
  GetPendingSettlementUseCase,
} from '../src/features/trip/domain/usecases';

/** Fake mínimo del HttpClient con los verbos que usan los repos de cierre. */
function fakeHttp(overrides: Partial<HttpClient>): HttpClient {
  return {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
    ...overrides,
  } as unknown as HttpClient;
}

const completedTrip: TripActiveView = {
  id: 'trip-1',
  status: 'COMPLETED',
  passengerId: 'pax-1',
  fareCents: 1500,
  currency: 'PEN',
  tipCents: 0,
  distanceMeters: 4200,
  durationSeconds: 540,
  paymentMethod: 'CASH',
  childMode: false,
  penaltyCents: 0,
  driver: null,
  vehicle: null,
};

const capturedPayment: PaymentView = {
  id: 'pay-1',
  tripId: 'trip-1',
  method: 'YAPE',
  status: 'CAPTURED',
  amountCents: 1500,
  grossCents: 1500,
  tipCents: 0,
  commissionCents: 150,
  feeCents: 0,
  externalRef: 'ext-1',
};

describe('HttpTripRepository · re-entrada del cierre', () => {
  it('getPendingSettlement() normaliza 204 (undefined) → null', async () => {
    const get = jest.fn(async () => undefined);
    const repo = new HttpTripRepository(fakeHttp({ get }));

    await expect(repo.getPendingSettlement()).resolves.toBeNull();
    expect(get).toHaveBeenCalledWith('/trips/pending-settlement', expect.objectContaining({ schema: expect.anything() }));
  });

  it('getPendingSettlement() devuelve el viaje COMPLETED cuando hay cierre pendiente', async () => {
    const get = jest.fn(async () => completedTrip);
    const repo = new HttpTripRepository(fakeHttp({ get }));

    await expect(repo.getPendingSettlement()).resolves.toEqual(completedTrip);
  });

  it('closeTrip() hace POST /trips/:id/close (idempotente) y devuelve el detalle', async () => {
    const post = jest.fn(async () => completedTrip);
    const repo = new HttpTripRepository(fakeHttp({ post }));

    await expect(repo.closeTrip('trip-1')).resolves.toEqual(completedTrip);
    expect(post).toHaveBeenCalledWith('/trips/trip-1/close', expect.objectContaining({ body: {} }));
  });
});

describe('HttpPaymentsRepository · recibo por viaje', () => {
  it('getPaymentByTrip() devuelve el recibo cuando existe', async () => {
    const get = jest.fn(async () => capturedPayment);
    const repo = new HttpPaymentsRepository(fakeHttp({ get }));

    await expect(repo.getPaymentByTrip('trip-1')).resolves.toEqual(capturedPayment);
    expect(get).toHaveBeenCalledWith('/payments/by-trip/trip-1', expect.objectContaining({ schema: expect.anything() }));
  });

  it('getPaymentByTrip() normaliza 404 (cobro aún no existe / anti-IDOR) → null', async () => {
    const get = jest.fn(async () => {
      throw new ApiError(404, 'NOT_FOUND', 'sin cobro');
    });
    const repo = new HttpPaymentsRepository(fakeHttp({ get }));

    await expect(repo.getPaymentByTrip('trip-1')).resolves.toBeNull();
  });

  it('getPaymentByTrip() PROPAGA errores que no son 404 (no los esconde como "sin cobro")', async () => {
    const get = jest.fn(async () => {
      throw new ApiError(500, 'INTERNAL', 'boom');
    });
    const repo = new HttpPaymentsRepository(fakeHttp({ get }));

    await expect(repo.getPaymentByTrip('trip-1')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('Casos de uso de cierre', () => {
  it('GetPendingSettlementUseCase delega en el repositorio', async () => {
    const repo = { getPendingSettlement: jest.fn(async () => completedTrip) };
    const uc = new GetPendingSettlementUseCase(repo as never);
    await expect(uc.execute()).resolves.toEqual(completedTrip);
  });

  it('CloseTripUseCase delega en el repositorio con el tripId', async () => {
    const repo = { closeTrip: jest.fn(async () => completedTrip) };
    const uc = new CloseTripUseCase(repo as never);
    await uc.execute('trip-1');
    expect(repo.closeTrip).toHaveBeenCalledWith('trip-1');
  });

  it('GetPaymentByTripUseCase propaga el null del repositorio (cobro aún no procesado)', async () => {
    const repo = { getPaymentByTrip: jest.fn(async () => null) };
    const uc = new GetPaymentByTripUseCase(repo as never);
    await expect(uc.execute('trip-1')).resolves.toBeNull();
  });
});
