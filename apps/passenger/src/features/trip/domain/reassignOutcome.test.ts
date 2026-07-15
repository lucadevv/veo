import {tripStatus} from '@veo/api-client';
import {resolveReassignOutcome} from './reassignOutcome';

describe('resolveReassignOutcome', () => {
  it('sin dato (poll aún sin respuesta) → stay', () => {
    expect(resolveReassignOutcome(null)).toBe('stay');
    expect(resolveReassignOutcome(undefined)).toBe('stay');
  });

  it('REASSIGNING (estado esperado de la pantalla) → stay', () => {
    expect(resolveReassignOutcome('REASSIGNING')).toBe('stay');
  });

  it('un conductor aceptó la re-oferta → adoptAndHome (retoma la fase viva)', () => {
    for (const status of [
      'ASSIGNED',
      'ACCEPTED',
      'ARRIVING',
      'ARRIVED',
      'IN_PROGRESS',
    ] as const) {
      expect(resolveReassignOutcome(status)).toBe('adoptAndHome');
    }
  });

  it('EXPIRED (re-búsqueda sin candidatos) → adoptAndHome (el flujo unificado reconstruye noDriver/noOffers)', () => {
    expect(resolveReassignOutcome('EXPIRED')).toBe('adoptAndHome');
  });

  it('la búsqueda re-abrió como puja normal (REQUESTED/MATCHING) → adoptAndHome', () => {
    expect(resolveReassignOutcome('REQUESTED')).toBe('adoptAndHome');
    expect(resolveReassignOutcome('MATCHING')).toBe('adoptAndHome');
  });

  it('viaje muerto (CANCELLED/FAILED) → homeOnly (sin adoptar)', () => {
    expect(resolveReassignOutcome('CANCELLED')).toBe('homeOnly');
    expect(resolveReassignOutcome('FAILED')).toBe('homeOnly');
  });

  it('es TOTAL sobre el enum del contrato: todo estado decide algo', () => {
    for (const status of tripStatus.options) {
      expect(['stay', 'adoptAndHome', 'homeOnly']).toContain(
        resolveReassignOutcome(status),
      );
    }
  });
});
