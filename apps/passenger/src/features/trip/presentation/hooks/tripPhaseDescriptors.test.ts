import type {TripPhase} from './tripFlowPhase';
import {
  ActiveTripPhaseBody,
  BiddingPhaseBody,
  CompletionPhaseBody,
  HomeIdleFlowBody,
  HomeIdleFlowHeader,
  HomePhaseBody,
  HomeSearchFlowBody,
  HomeSearchFlowHeader,
  HomeSheetHeader,
  NoOffersPhaseBody,
  QuotingPhaseBody,
  QuotingSheetHeader,
  resolvePickupMode,
  SHEET_FLOW_DESCRIPTORS,
  TRIP_PHASE_DESCRIPTORS,
  type PhaseDescriptor,
} from './tripPhaseDescriptors';

/**
 * El descriptor ES el wiring del sheet unificado: si alguien re-cablea una fase (Body equivocado, snap
 * full donde iba peek, ambiente donde no va), este test lo caza. Espejo 1:1 de la cadena ternaria + los
 * booleans fase-derivados que vivían desparramados en RequestFlowScreen.
 */
describe('TRIP_PHASE_DESCRIPTORS', () => {
  it('cada fase renderiza SU body (la ex-cadena ternaria del screen)', () => {
    const expected: Record<TripPhase, PhaseDescriptor['Body']> = {
      idle: HomePhaseBody,
      quoting: QuotingPhaseBody,
      searching: BiddingPhaseBody,
      offers: BiddingPhaseBody,
      noOffers: NoOffersPhaseBody,
      // Transitorias: el PUENTE navega/limpia; mientras tanto el sheet muestra el home (igual que antes).
      reassigning: HomePhaseBody,
      ended: HomePhaseBody,
      enRoute: ActiveTripPhaseBody,
      arrived: ActiveTripPhaseBody,
      inProgress: ActiveTripPhaseBody,
      completed: CompletionPhaseBody,
    };
    for (const phase of Object.keys(expected) as TripPhase[]) {
      expect(TRIP_PHASE_DESCRIPTORS[phase].Body).toBe(expected[phase]);
    }
  });

  it('WHITELIST de header: solo home y cotización tienen chrome fijo (el resto, cuerpo autocontenido)', () => {
    const expected: Record<TripPhase, PhaseDescriptor['Header']> = {
      idle: HomeSheetHeader,
      quoting: QuotingSheetHeader,
      searching: null,
      offers: null,
      noOffers: null,
      reassigning: null,
      enRoute: null,
      arrived: null,
      inProgress: null,
      completed: null,
      ended: null,
    };
    for (const phase of Object.keys(expected) as TripPhase[]) {
      expect(TRIP_PHASE_DESCRIPTORS[phase].Header).toBe(expected[phase]);
    }
  });

  it('snap a FULL en cotización, cierre y OFERTAS (ADR-020 Lote 3: con ≥1 oferta el sheet crece para ver la lista); el resto abraza el contenido (peek)', () => {
    const fullPhases = (
      Object.keys(TRIP_PHASE_DESCRIPTORS) as TripPhase[]
    ).filter(phase => TRIP_PHASE_DESCRIPTORS[phase].expanded);
    expect(fullPhases.sort()).toEqual(['completed', 'offers', 'quoting']);
  });

  it('AMBIENTE (autitos cercanos) solo en idle, searching y completed', () => {
    const nearbyPhases = (
      Object.keys(TRIP_PHASE_DESCRIPTORS) as TripPhase[]
    ).filter(phase => TRIP_PHASE_DESCRIPTORS[phase].showNearby);
    expect(nearbyPhases.sort()).toEqual(['completed', 'idle', 'searching']);
  });

  it('viaje VIVO (chrome SOS/chat + pánico armado) solo en enRoute/arrived/inProgress', () => {
    const activePhases = (
      Object.keys(TRIP_PHASE_DESCRIPTORS) as TripPhase[]
    ).filter(phase => TRIP_PHASE_DESCRIPTORS[phase].activeTrip);
    expect(activePhases.sort()).toEqual(['arrived', 'enRoute', 'inProgress']);
  });

  it('detalle del viaje (conductor/tarifa) solo donde el body lo consume: viaje activo + cierre', () => {
    const detailPhases = (
      Object.keys(TRIP_PHASE_DESCRIPTORS) as TripPhase[]
    ).filter(phase => TRIP_PHASE_DESCRIPTORS[phase].needsTripDetail);
    expect(detailPhases.sort()).toEqual([
      'arrived',
      'completed',
      'enRoute',
      'inProgress',
    ]);
  });

  it('señales del home idle (deudas) y de la búsqueda de conductor (pre-prompt de push)', () => {
    for (const phase of Object.keys(TRIP_PHASE_DESCRIPTORS) as TripPhase[]) {
      expect(TRIP_PHASE_DESCRIPTORS[phase].pollsDebts).toBe(phase === 'idle');
      expect(TRIP_PHASE_DESCRIPTORS[phase].showsPushPrePrompt).toBe(
        phase === 'searching',
      );
    }
  });

  it('el marker de ORIGEN del mapa de viaje se apaga SOLO en curso (ya pasamos por la recogida)', () => {
    for (const phase of Object.keys(TRIP_PHASE_DESCRIPTORS) as TripPhase[]) {
      expect(TRIP_PHASE_DESCRIPTORS[phase].tripMapShowsOrigin).toBe(
        phase !== 'inProgress',
      );
    }
  });

  it('PUENTE interino: reassigning navega, ended limpia, el resto vive en el sheet', () => {
    for (const phase of Object.keys(TRIP_PHASE_DESCRIPTORS) as TripPhase[]) {
      const expected =
        phase === 'reassigning'
          ? 'reassign'
          : phase === 'ended'
            ? 'clear'
            : null;
      expect(TRIP_PHASE_DESCRIPTORS[phase].handoff).toBe(expected);
    }
  });
});

describe('SHEET_FLOW_DESCRIPTORS (la 2ª máquina: eje local del sheet en el home)', () => {
  it('idle → atajos (franja de deuda + favoritos/recientes) con buscador+chips; searching → búsqueda in-sheet', () => {
    expect(SHEET_FLOW_DESCRIPTORS.idle.Body).toBe(HomeIdleFlowBody);
    expect(SHEET_FLOW_DESCRIPTORS.idle.Header).toBe(HomeIdleFlowHeader);
    expect(SHEET_FLOW_DESCRIPTORS.searching.Body).toBe(HomeSearchFlowBody);
    expect(SHEET_FLOW_DESCRIPTORS.searching.Header).toBe(HomeSearchFlowHeader);
  });

  it('el pin de recojo (modelo Cabify) solo aplica con el sheet en reposo', () => {
    expect(SHEET_FLOW_DESCRIPTORS.idle.allowsPickupPin).toBe(true);
    expect(SHEET_FLOW_DESCRIPTORS.searching.allowsPickupPin).toBe(false);
  });
});

describe('resolvePickupMode (composición EXPLÍCITA de las dos máquinas)', () => {
  it('solo Home idle con el sheet en reposo', () => {
    expect(resolvePickupMode('idle', 'idle')).toBe(true);
    expect(resolvePickupMode('idle', 'searching')).toBe(false);
  });

  it('cualquier otra fase lo apaga, sin importar el flow', () => {
    const phases = (Object.keys(TRIP_PHASE_DESCRIPTORS) as TripPhase[]).filter(
      p => p !== 'idle',
    );
    for (const phase of phases) {
      expect(resolvePickupMode(phase, 'idle')).toBe(false);
      expect(resolvePickupMode(phase, 'searching')).toBe(false);
    }
  });
});
