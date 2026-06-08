import { describe, it, expect } from 'vitest';
import { InvalidStateError } from '@veo/utils';
import { TripStatus } from '@veo/shared-types';
import {
  assertTransition,
  canTransition,
  isTerminal,
  InvalidTripTransition,
  transitionSources,
  TRIP_TRANSITIONS,
  TERMINAL_STATES,
} from './trip-state-machine';

const ALL_STATES = Object.values(TripStatus);

/**
 * Conjunto de transiciones válidas esperadas, declarado de forma independiente a la tabla
 * de producción para no tautologizar el test. Si la tabla cambia, este set debe cambiar.
 */
const EXPECTED_VALID = new Set<string>([
  // viaje programado (Ola 2B): SCHEDULED → activación / cancelación con antelación / expiración
  `${TripStatus.SCHEDULED}->${TripStatus.REQUESTED}`,
  `${TripStatus.SCHEDULED}->${TripStatus.CANCELLED_BY_PASSENGER}`,
  `${TripStatus.SCHEDULED}->${TripStatus.EXPIRED}`,
  // happy path
  `${TripStatus.REQUESTED}->${TripStatus.ASSIGNED}`,
  `${TripStatus.ASSIGNED}->${TripStatus.ACCEPTED}`,
  `${TripStatus.ACCEPTED}->${TripStatus.ARRIVING}`,
  `${TripStatus.ARRIVING}->${TripStatus.ARRIVED}`,
  `${TripStatus.ARRIVED}->${TripStatus.IN_PROGRESS}`,
  `${TripStatus.IN_PROGRESS}->${TripStatus.COMPLETED}`,
  // cancelaciones del pasajero
  `${TripStatus.REQUESTED}->${TripStatus.CANCELLED_BY_PASSENGER}`,
  `${TripStatus.ASSIGNED}->${TripStatus.CANCELLED_BY_PASSENGER}`,
  `${TripStatus.ACCEPTED}->${TripStatus.CANCELLED_BY_PASSENGER}`,
  `${TripStatus.ARRIVING}->${TripStatus.CANCELLED_BY_PASSENGER}`,
  `${TripStatus.ARRIVED}->${TripStatus.CANCELLED_BY_PASSENGER}`,
  // cancelación del conductor PRE-accept (sigue siendo terminal CANCELLED_BY_DRIVER):
  `${TripStatus.ASSIGNED}->${TripStatus.CANCELLED_BY_DRIVER}`,
  // PUJA · cancelación del conductor POST-accept → REASSIGNING (ADR 010 #4, ya no termina):
  `${TripStatus.ACCEPTED}->${TripStatus.REASSIGNING}`,
  `${TripStatus.ARRIVING}->${TripStatus.REASSIGNING}`,
  `${TripStatus.ARRIVED}->${TripStatus.REASSIGNING}`,
  // PUJA · reasignación (ADR 010 §3.1): re-match / sin ofertas / pasajero se rinde:
  `${TripStatus.REASSIGNING}->${TripStatus.ASSIGNED}`,
  `${TripStatus.REASSIGNING}->${TripStatus.EXPIRED}`,
  `${TripStatus.REASSIGNING}->${TripStatus.CANCELLED_BY_PASSENGER}`,
  // RE-BID (ADR 010 #4/#12 · H6.4): el pasajero RE-PUJA explícitamente → vuelve a REQUESTED (board fresco)
  `${TripStatus.REASSIGNING}->${TripStatus.REQUESTED}`,
  `${TripStatus.EXPIRED}->${TripStatus.REQUESTED}`,
  // expiración
  `${TripStatus.REQUESTED}->${TripStatus.EXPIRED}`,
  `${TripStatus.ASSIGNED}->${TripStatus.EXPIRED}`,
  // fallo del sistema (cualquier estado activo)
  `${TripStatus.REQUESTED}->${TripStatus.FAILED}`,
  `${TripStatus.ASSIGNED}->${TripStatus.FAILED}`,
  `${TripStatus.ACCEPTED}->${TripStatus.FAILED}`,
  `${TripStatus.ARRIVING}->${TripStatus.FAILED}`,
  `${TripStatus.ARRIVED}->${TripStatus.FAILED}`,
  `${TripStatus.IN_PROGRESS}->${TripStatus.FAILED}`,
  `${TripStatus.REASSIGNING}->${TripStatus.FAILED}`,
]);

describe('BR-T02 · máquina de estados — cobertura 100% del producto cartesiano', () => {
  // 13 x 13 = 169 pares (from, to). Verificamos CADA uno (incluye SCHEDULED de Ola 2B y REASSIGNING).
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      const key = `${from}->${to}`;
      const shouldBeValid = EXPECTED_VALID.has(key);

      it(`${from} → ${to} ${shouldBeValid ? 'es válida' : 'es inválida'}`, () => {
        expect(canTransition(from, to)).toBe(shouldBeValid);
        if (shouldBeValid) {
          expect(() => assertTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertTransition(from, to)).toThrow(InvalidTripTransition);
          // InvalidTripTransition es subclase de InvalidStateError de @veo/utils.
          expect(() => assertTransition(from, to)).toThrow(InvalidStateError);
        }
      });
    }
  }

  it('expone exactamente los estados terminales esperados', () => {
    // EXPIRED ya NO es terminal (H6.4 re-bid): tiene salida EXPIRED → REQUESTED.
    expect([...TERMINAL_STATES].sort()).toEqual(
      [
        TripStatus.COMPLETED,
        TripStatus.CANCELLED_BY_PASSENGER,
        TripStatus.CANCELLED_BY_DRIVER,
        TripStatus.FAILED,
      ].sort(),
    );
    for (const s of TERMINAL_STATES) {
      expect(isTerminal(s)).toBe(true);
      expect(TRIP_TRANSITIONS[s]).toHaveLength(0);
    }
  });

  it('los estados activos no son terminales', () => {
    for (const s of [
      TripStatus.SCHEDULED,
      TripStatus.REQUESTED,
      TripStatus.ASSIGNED,
      TripStatus.ACCEPTED,
      TripStatus.ARRIVING,
      TripStatus.ARRIVED,
      TripStatus.IN_PROGRESS,
      TripStatus.REASSIGNING,
      // EXPIRED reactivable (H6.4): el pasajero puede re-pujar desde aquí, ya no es callejón sin salida.
      TripStatus.EXPIRED,
    ]) {
      expect(isTerminal(s)).toBe(false);
    }
  });

  it('InvalidTripTransition lleva from/to en details y código INVALID_STATE', () => {
    try {
      assertTransition(TripStatus.COMPLETED, TripStatus.IN_PROGRESS);
      expect.unreachable('debió lanzar');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTripTransition);
      const e = err as InvalidTripTransition;
      expect(e.code).toBe('INVALID_STATE');
      expect(e.httpStatus).toBe(409);
      expect(e.details).toMatchObject({
        from: TripStatus.COMPLETED,
        to: TripStatus.IN_PROGRESS,
      });
    }
  });

  // transitionSources(to) = la inversa de la tabla. Es el conjunto que alimenta el guard CAS atómico
  // de assign() (WHERE status IN sources). DEBE coincidir, par a par, con canTransition(from, to).
  describe('transitionSources (inversa de la tabla · guards CAS)', () => {
    it('ASSIGNED es alcanzable SOLO desde REQUESTED y REASSIGNING', () => {
      expect([...transitionSources(TripStatus.ASSIGNED)].sort()).toEqual(
        [TripStatus.REQUESTED, TripStatus.REASSIGNING].sort(),
      );
    });

    it('es consistente con canTransition para CADA destino (sin estados fantasma ni faltantes)', () => {
      for (const to of ALL_STATES) {
        const sources = new Set(transitionSources(to));
        for (const from of ALL_STATES) {
          expect(sources.has(from)).toBe(canTransition(from, to));
        }
      }
    });

    it('un destino inalcanzable (SCHEDULED, estado inicial) no tiene fuentes', () => {
      expect(transitionSources(TripStatus.SCHEDULED)).toEqual([]);
    });
  });
});
