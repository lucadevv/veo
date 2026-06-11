import { describe, it, expect } from 'vitest';
import { InvalidStateError } from '@veo/utils';
import {
  WaypointProposalStatus,
  WAYPOINT_PROPOSAL_TRANSITIONS,
  WAYPOINT_PROPOSAL_TERMINAL,
  InvalidWaypointProposalTransition,
  canTransition,
  isTerminal,
  assertTransition,
  computeFareDelta,
  isExpired,
} from './waypoint-proposal';

describe('BR-T01 · máquina de transiciones de la propuesta de parada', () => {
  it('PROPOSED transiciona a ACCEPTED, REJECTED y EXPIRED', () => {
    expect(canTransition(WaypointProposalStatus.PROPOSED, WaypointProposalStatus.ACCEPTED)).toBe(true);
    expect(canTransition(WaypointProposalStatus.PROPOSED, WaypointProposalStatus.REJECTED)).toBe(true);
    expect(canTransition(WaypointProposalStatus.PROPOSED, WaypointProposalStatus.EXPIRED)).toBe(true);
  });

  it('PROPOSED no transiciona a sí mismo', () => {
    expect(canTransition(WaypointProposalStatus.PROPOSED, WaypointProposalStatus.PROPOSED)).toBe(false);
  });

  it('los estados terminales no transicionan a ningún lado', () => {
    const terminals = [
      WaypointProposalStatus.ACCEPTED,
      WaypointProposalStatus.REJECTED,
      WaypointProposalStatus.EXPIRED,
    ] as const;
    const targets = Object.values(WaypointProposalStatus);

    for (const from of terminals) {
      for (const to of targets) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it('assertTransition pasa para PROPOSED → ACCEPTED', () => {
    expect(() =>
      assertTransition(WaypointProposalStatus.PROPOSED, WaypointProposalStatus.ACCEPTED),
    ).not.toThrow();
  });

  it('assertTransition lanza InvalidWaypointProposalTransition desde un terminal', () => {
    expect(() =>
      assertTransition(WaypointProposalStatus.ACCEPTED, WaypointProposalStatus.REJECTED),
    ).toThrow(InvalidWaypointProposalTransition);
  });

  it('InvalidWaypointProposalTransition es subclase de InvalidStateError', () => {
    expect(() =>
      assertTransition(WaypointProposalStatus.EXPIRED, WaypointProposalStatus.ACCEPTED),
    ).toThrow(InvalidStateError);
  });

  it('el error incluye los estados from y to en el contexto', () => {
    try {
      assertTransition(WaypointProposalStatus.REJECTED, WaypointProposalStatus.ACCEPTED);
      expect.unreachable('debería haber lanzado');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidWaypointProposalTransition);
      const e = err as InvalidWaypointProposalTransition;
      expect(e.message).toContain('REJECTED');
      expect(e.message).toContain('ACCEPTED');
    }
  });

  it('isTerminal: solo PROPOSED es no-terminal', () => {
    expect(isTerminal(WaypointProposalStatus.PROPOSED)).toBe(false);
    expect(isTerminal(WaypointProposalStatus.ACCEPTED)).toBe(true);
    expect(isTerminal(WaypointProposalStatus.REJECTED)).toBe(true);
    expect(isTerminal(WaypointProposalStatus.EXPIRED)).toBe(true);
  });

  it('el set terminal coincide con los estados de transiciones vacías', () => {
    expect(WAYPOINT_PROPOSAL_TERMINAL.has(WaypointProposalStatus.ACCEPTED)).toBe(true);
    expect(WAYPOINT_PROPOSAL_TERMINAL.has(WaypointProposalStatus.REJECTED)).toBe(true);
    expect(WAYPOINT_PROPOSAL_TERMINAL.has(WaypointProposalStatus.EXPIRED)).toBe(true);
    expect(WAYPOINT_PROPOSAL_TERMINAL.has(WaypointProposalStatus.PROPOSED)).toBe(false);
    expect(WAYPOINT_PROPOSAL_TRANSITIONS[WaypointProposalStatus.PROPOSED].length).toBe(3);
  });
});

describe('BR-T05 · computeFareDelta (delta de tarifa al agregar la parada)', () => {
  it('delta positivo: la parada agrega distancia/tiempo', () => {
    // ruta nueva 1800 céntimos vs actual 1500 → +300
    expect(computeFareDelta(1800, 1500)).toBe(300);
  });

  it('delta cero: la parada no cambia la tarifa', () => {
    expect(computeFareDelta(1500, 1500)).toBe(0);
  });

  it('delta negativo: rutas raras del motor (resta pura de enteros)', () => {
    // el dominio NO clampea; el caller decide si lo permite
    expect(computeFareDelta(1400, 1500)).toBe(-100);
  });

  it('opera en céntimos enteros sin redondeo', () => {
    expect(computeFareDelta(2451, 2249)).toBe(202);
  });
});

describe('BR-T01 · isExpired (TTL de la propuesta respecto a un reloj dado)', () => {
  const now = new Date('2026-06-10T12:00:00.000Z');

  it('no vencida: expiresAt en el futuro respecto a now', () => {
    const expiresAt = new Date('2026-06-10T12:00:30.000Z');
    expect(isExpired(expiresAt, now)).toBe(false);
  });

  it('vencida: expiresAt en el pasado respecto a now', () => {
    const expiresAt = new Date('2026-06-10T11:59:30.000Z');
    expect(isExpired(expiresAt, now)).toBe(true);
  });

  it('borde: expiresAt igual a now cuenta como vencida (≤)', () => {
    const expiresAt = new Date('2026-06-10T12:00:00.000Z');
    expect(isExpired(expiresAt, now)).toBe(true);
  });

  it('es determinista: no depende del reloj real del sistema', () => {
    const expiresAt = new Date('2030-01-01T00:00:00.000Z');
    const fixedNow = new Date('2029-12-31T23:59:59.999Z');
    expect(isExpired(expiresAt, fixedNow)).toBe(false);
  });
});
