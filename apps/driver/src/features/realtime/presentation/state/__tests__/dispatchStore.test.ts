import { useDispatchStore } from '../dispatchStore';

describe('dispatchStore', () => {
  beforeEach(() => {
    useDispatchStore.setState({ incomingOffer: null, activeTripId: null, connected: false });
  });

  it('refleja el estado de conexión del socket /driver', () => {
    expect(useDispatchStore.getState().connected).toBe(false);
    useDispatchStore.getState().setConnected(true);
    expect(useDispatchStore.getState().connected).toBe(true);
    useDispatchStore.getState().setConnected(false);
    expect(useDispatchStore.getState().connected).toBe(false);
  });

  it('registra y limpia la oferta entrante', () => {
    const offer = { matchId: 'm1', tripId: 't1', expiresAt: '2026-01-01T00:00:00.000Z' };
    useDispatchStore.getState().setIncomingOffer(offer);
    expect(useDispatchStore.getState().incomingOffer).toEqual(offer);

    useDispatchStore.getState().clearOffer();
    expect(useDispatchStore.getState().incomingOffer).toBeNull();
  });

  it('conserva la marca de reserva (scheduled) de la oferta', () => {
    const reserved = {
      matchId: 'm2',
      tripId: 't2',
      expiresAt: '2026-01-01T00:00:00.000Z',
      scheduled: true,
    };
    useDispatchStore.getState().setIncomingOffer(reserved);
    expect(useDispatchStore.getState().incomingOffer?.scheduled).toBe(true);
  });

  it('mantiene el viaje activo de forma independiente de la oferta', () => {
    useDispatchStore.getState().setActiveTripId('t9');
    useDispatchStore.getState().clearOffer();
    expect(useDispatchStore.getState().activeTripId).toBe('t9');
  });
});
