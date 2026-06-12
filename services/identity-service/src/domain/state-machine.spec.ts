import { describe, it, expect } from 'vitest';
import { InvalidStateError } from '@veo/utils';
import { createStateMachine, InvalidStatusTransition } from './state-machine';

/** Eje de juguete para testear la MECÁNICA de la fábrica (las tablas reales tienen su propio spec). */
type Toy = 'A' | 'B' | 'C';
const toy = createStateMachine<Toy>('eje de prueba', {
  A: ['B'],
  B: ['C'],
  C: [],
});

describe('createStateMachine · mecánica común de los cuatro ejes', () => {
  it('acepta las transiciones listadas y rechaza las no listadas', () => {
    expect(toy.canTransition('A', 'B')).toBe(true);
    expect(() => toy.assertTransition('A', 'B')).not.toThrow();
    expect(toy.canTransition('A', 'C')).toBe(false);
    expect(() => toy.assertTransition('A', 'C')).toThrow(InvalidStatusTransition);
  });

  it('re-aplicar el MISMO estado (from === to) es válido incluso en estados terminales', () => {
    expect(toy.canTransition('C', 'C')).toBe(true);
    expect(() => toy.assertTransition('C', 'C')).not.toThrow();
  });

  it('`from` fuera del enum (string legacy de DB) → InvalidStatusTransition, nunca TypeError', () => {
    const legacy = 'LEGACY_GARBAGE' as Toy;
    expect(toy.canTransition(legacy, 'A')).toBe(false);
    expect(() => toy.assertTransition(legacy, 'A')).toThrow(InvalidStatusTransition);
  });

  it('`from` desconocido es inválido aun con from === to (no hay idempotencia de basura)', () => {
    const legacy = 'LEGACY_GARBAGE' as Toy;
    expect(toy.canTransition(legacy, legacy)).toBe(false);
    expect(() => toy.assertTransition(legacy, legacy)).toThrow(InvalidStatusTransition);
  });

  it('InvalidStatusTransition integra el canon de errores: INVALID_STATE / 409 / details con eje', () => {
    try {
      toy.assertTransition('C', 'A');
      expect.unreachable('debió lanzar');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidStatusTransition);
      // Subclase de InvalidStateError de @veo/utils → el exception filter la mapea a 409.
      expect(err).toBeInstanceOf(InvalidStateError);
      const e = err as InvalidStatusTransition;
      expect(e.code).toBe('INVALID_STATE');
      expect(e.httpStatus).toBe(409);
      expect(e.details).toMatchObject({ axis: 'eje de prueba', from: 'C', to: 'A' });
    }
  });
});
