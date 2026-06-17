import type { BiddingRepository, OpenBid, SubmitOfferInput, SubmittedOffer } from '../index';
import {
  AcceptBidUseCase,
  BID_MAX_CENTS,
  CounterBidUseCase,
  InvalidCounterOfferError,
  ListOpenBidsUseCase,
} from '../index';

const BID: OpenBid = {
  tripId: 't1',
  bidCents: 1500,
  vehicleType: 'CAR',
  expiresAt: 1_700_000_000_000,
  originLat: -12.0464,
  originLon: -77.0428,
  specialRequests: [],
};

/** Doble de prueba del repositorio de pujas: captura el último submit (no es un mock de producción). */
class FakeBiddingRepository implements BiddingRepository {
  lastSubmit: { tripId: string; input: SubmitOfferInput } | null = null;
  readonly bids: OpenBid[] = [BID];

  listOpenBids(): Promise<OpenBid[]> {
    return Promise.resolve(this.bids);
  }
  submitOffer(tripId: string, input: SubmitOfferInput): Promise<SubmittedOffer> {
    this.lastSubmit = { tripId, input };
    return Promise.resolve({
      tripId,
      driverId: 'd1',
      kind: input.kind,
      priceCents: input.priceCents,
      etaSeconds: 120,
      status: 'PENDING',
    });
  }
}

describe('ListOpenBidsUseCase', () => {
  it('devuelve las pujas abiertas del repositorio', async () => {
    const repo = new FakeBiddingRepository();
    const bids = await new ListOpenBidsUseCase(repo).execute();
    expect(bids).toEqual([BID]);
  });
});

describe('AcceptBidUseCase', () => {
  it('envía ACCEPT_PRICE con priceCents EXACTAMENTE igual al bid (sin ambigüedad)', async () => {
    const repo = new FakeBiddingRepository();
    await new AcceptBidUseCase(repo).execute(BID);
    expect(repo.lastSubmit).toEqual({
      tripId: 't1',
      input: { kind: 'ACCEPT_PRICE', priceCents: 1500 },
    });
  });
});

describe('CounterBidUseCase', () => {
  it('envía COUNTER cuando el precio es mayor al bid y dentro del techo', async () => {
    const repo = new FakeBiddingRepository();
    await new CounterBidUseCase(repo).execute(BID, 1800);
    expect(repo.lastSubmit).toEqual({
      tripId: 't1',
      input: { kind: 'COUNTER', priceCents: 1800 },
    });
  });

  it('RECHAZA un COUNTER igual o menor al bid (debe ser estrictamente mayor)', () => {
    const repo = new FakeBiddingRepository();
    const uc = new CounterBidUseCase(repo);
    // Valida ANTES de pegarle al backend → lanza sincrónicamente (misma convención que StartTripUseCase).
    expect(() => uc.execute(BID, 1500)).toThrow(InvalidCounterOfferError);
    expect(() => uc.execute(BID, 1400)).toThrow(InvalidCounterOfferError);
    // No debe haber pegado al backend con un valor inválido.
    expect(repo.lastSubmit).toBeNull();
  });

  it('RECHAZA un COUNTER que supera el techo (BID_MAX_CENTS)', () => {
    const repo = new FakeBiddingRepository();
    expect(() => new CounterBidUseCase(repo).execute(BID, BID_MAX_CENTS + 1)).toThrow(
      InvalidCounterOfferError,
    );
    expect(repo.lastSubmit).toBeNull();
  });

  it('ACEPTA un COUNTER exactamente en el techo (borde inclusivo)', async () => {
    const repo = new FakeBiddingRepository();
    await new CounterBidUseCase(repo).execute(BID, BID_MAX_CENTS);
    expect(repo.lastSubmit?.input.priceCents).toBe(BID_MAX_CENTS);
  });
});
