import {
  resolveTripPhase,
  mapModeForPhase,
  isLiveSocketPhase,
  type TripPhase,
} from './tripFlowPhase';

describe('resolveTripPhase', () => {
  const base = {
    hasDestination: false,
    activeTripId: null,
    status: null,
    offerCount: 0,
  } as const;

  it('sin destino ni viaje → idle', () => {
    expect(resolveTripPhase(base)).toBe('idle');
  });

  it('destino elegido, sin viaje → quoting', () => {
    expect(resolveTripPhase({...base, hasDestination: true})).toBe('quoting');
  });

  it('viaje creado, puja abierta sin ofertas → searching', () => {
    expect(
      resolveTripPhase({
        ...base,
        activeTripId: 't1',
        status: 'REQUESTED',
        offerCount: 0,
      }),
    ).toBe('searching');
    expect(
      resolveTripPhase({
        ...base,
        activeTripId: 't1',
        status: 'MATCHING',
        offerCount: 0,
      }),
    ).toBe('searching');
  });

  it('puja abierta con ofertas → offers', () => {
    expect(
      resolveTripPhase({
        ...base,
        activeTripId: 't1',
        status: 'REQUESTED',
        offerCount: 2,
      }),
    ).toBe('offers');
  });

  it('mapea estados crudos fuera del enum (EXPIRED/REASSIGNING/FAILED)', () => {
    expect(
      resolveTripPhase({...base, activeTripId: 't1', status: 'EXPIRED'}),
    ).toBe('noOffers');
    expect(
      resolveTripPhase({...base, activeTripId: 't1', status: 'REASSIGNING'}),
    ).toBe('reassigning');
    expect(
      resolveTripPhase({...base, activeTripId: 't1', status: 'FAILED'}),
    ).toBe('ended');
  });

  it('EXPIRED ramifica por MODO: PUJA → noOffers (re-pujar), FIXED → noDriver (sin conductor)', () => {
    // Sin modo (null/undefined) degrada al histórico PUJA: sigue siendo noOffers (no regresión).
    expect(
      resolveTripPhase({...base, activeTripId: 't1', status: 'EXPIRED'}),
    ).toBe('noOffers');
    expect(
      resolveTripPhase({
        ...base,
        activeTripId: 't1',
        status: 'EXPIRED',
        mode: 'PUJA',
      }),
    ).toBe('noOffers');
    // Un FIJO que expira NO va a "pon tu precio / re-pujar" (eso es puja) → su propio estado sin conductor.
    expect(
      resolveTripPhase({
        ...base,
        activeTripId: 't1',
        status: 'EXPIRED',
        mode: 'FIXED',
      }),
    ).toBe('noDriver');
  });

  it('viaje activo: asignado/en camino → enRoute; llegó → arrived; en curso → inProgress', () => {
    for (const s of ['ASSIGNED', 'ACCEPTED', 'ARRIVING'] as const) {
      expect(resolveTripPhase({...base, activeTripId: 't1', status: s})).toBe(
        'enRoute',
      );
    }
    expect(
      resolveTripPhase({...base, activeTripId: 't1', status: 'ARRIVED'}),
    ).toBe('arrived');
    expect(
      resolveTripPhase({...base, activeTripId: 't1', status: 'IN_PROGRESS'}),
    ).toBe('inProgress');
  });

  it('completado → completed; cancelado → ended', () => {
    expect(
      resolveTripPhase({...base, activeTripId: 't1', status: 'COMPLETED'}),
    ).toBe('completed');
    expect(
      resolveTripPhase({...base, activeTripId: 't1', status: 'CANCELLED'}),
    ).toBe('ended');
  });

  it('viaje activo con estado desconocido → searching (no rompe)', () => {
    expect(resolveTripPhase({...base, activeTripId: 't1', status: 'WAT'})).toBe(
      'searching',
    );
  });
});

describe('mapModeForPhase', () => {
  const expected: Record<TripPhase, ReturnType<typeof mapModeForPhase>> = {
    idle: 'idle',
    quoting: 'route',
    searching: 'route',
    offers: 'route',
    noOffers: 'route',
    noDriver: 'route',
    reassigning: 'route',
    enRoute: 'trip',
    arrived: 'trip',
    inProgress: 'trip',
    completed: 'trip',
    ended: 'idle',
  };
  it('cada fase mapea a su modo de mapa', () => {
    for (const phase of Object.keys(expected) as TripPhase[]) {
      expect(mapModeForPhase(phase)).toBe(expected[phase]);
    }
  });
});

describe('isLiveSocketPhase', () => {
  it('fases VIVAS (puja + viaje activo) → conectar socket', () => {
    for (const phase of [
      'searching',
      'offers',
      'noOffers',
      // noDriver (FIXED EXPIRED) mantiene el socket como noOffers: cerrarlo resetea live.status y la fase
      // oscila noDriver↔searching (parpadeo). El socket abierto en EXPIRED mantiene el status estable.
      'noDriver',
      'reassigning',
      'enRoute',
      'arrived',
      'inProgress',
    ] as const) {
      expect(isLiveSocketPhase(phase)).toBe(true);
    }
  });

  it('completed/settlement, ended, idle y quoting → NO conectar (evita el loop de handshakes rechazados)', () => {
    for (const phase of ['idle', 'quoting', 'completed', 'ended'] as const) {
      expect(isLiveSocketPhase(phase)).toBe(false);
    }
  });
});
