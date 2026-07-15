import { describe, it, expect } from 'vitest';
import { ValidationError } from '@veo/utils';
import {
  assertStopoverOrdersValid,
  assertTramosReferToValidStopovers,
  destinoOrden,
  validStopoverOrders,
} from './trip-segments';

/**
 * Invariante de dominio stopovers↔tramos (FIX 3): un tramo de pricing debe referenciar HITOS que existen en
 * la ruta (origen=0 ∪ stopovers ∪ destino). Tramo huérfano → ValidationError. Cubre el cálculo del set de
 * hitos válidos y los casos de aceptación/rechazo.
 *
 * MODELO DE HITOS (FIX 1): el destino es un hito PROPIO DESPUÉS del último stopover (`max+1`), NO el último
 * stopover. `destinoOrden()` es la fuente única que comparten validación y resolver del service.
 */
describe('destinoOrden (fuente única del orden del destino)', () => {
  it('sin stopovers → destino = 1 (origen=0 → destino=1)', () => {
    expect(destinoOrden([])).toBe(1);
  });

  it('con stopovers 1..2 → destino = max+1 = 3 (hito propio tras el último stopover)', () => {
    expect(destinoOrden([{ orden: 1 }, { orden: 2 }])).toBe(3);
  });
});

describe('validStopoverOrders', () => {
  it('sin stopovers: hitos { 0 (origen), 1 (destino) }', () => {
    expect([...validStopoverOrders([])].sort()).toEqual([0, 1]);
  });

  it('con stopovers 1..2: hitos { 0, 1, 2, 3 } (destino = max+1 = 3, hito propio)', () => {
    expect([...validStopoverOrders([{ orden: 1 }, { orden: 2 }])].sort()).toEqual([0, 1, 2, 3]);
  });
});

describe('assertStopoverOrdersValid (invariante de hitos · FIX 1 anti-lucro)', () => {
  it('sin stopovers → válido (origen=0 / destino=1, sin hitos intermedios)', () => {
    expect(() => assertStopoverOrdersValid([])).not.toThrow();
  });

  it('stopovers {1..n} contiguos y únicos → válido', () => {
    expect(() =>
      assertStopoverOrdersValid([{ orden: 1 }, { orden: 2 }, { orden: 3 }]),
    ).not.toThrow();
  });

  it('stopovers en cualquier ENTRADA (desordenados) pero {1..n} únicos → válido', () => {
    expect(() => assertStopoverOrdersValid([{ orden: 2 }, { orden: 1 }])).not.toThrow();
  });

  it('stopover orden=0 → ValidationError (0 reservado al origen, lo pisaría)', () => {
    expect(() => assertStopoverOrdersValid([{ orden: 0 }])).toThrow(ValidationError);
  });

  it('dos stopovers con el MISMO orden → ValidationError (se pisarían)', () => {
    expect(() => assertStopoverOrdersValid([{ orden: 1 }, { orden: 1 }])).toThrow(ValidationError);
  });

  it('stopover en orden = destino (n+1) → ValidationError (excede {1..n}, pisaría el destino)', () => {
    // n=1 → destino=2. Un stopover en orden 2 colisionaría con el destino.
    expect(() => assertStopoverOrdersValid([{ orden: 2 }])).toThrow(ValidationError);
  });

  it('stopovers con hueco (no contiguo: {1,3} con n=2) → ValidationError (3 > n)', () => {
    expect(() => assertStopoverOrdersValid([{ orden: 1 }, { orden: 3 }])).toThrow(ValidationError);
  });

  it('orden no entero → ValidationError', () => {
    expect(() => assertStopoverOrdersValid([{ orden: 1.5 }])).toThrow(ValidationError);
  });
});

describe('assertTramosReferToValidStopovers', () => {
  it('tramo full-route 0→1 sin stopovers → válido', () => {
    expect(() =>
      assertTramosReferToValidStopovers([], [{ desdeOrden: 0, hastaOrden: 1 }]),
    ).not.toThrow();
  });

  it('tramos encadenados sobre hitos existentes → válido', () => {
    // stopovers 1..2 → hitos { 0, 1, 2, 3 } (destino = max+1 = 3). tramos 0→1 y 1→2 son válidos.
    expect(() =>
      assertTramosReferToValidStopovers(
        [{ orden: 1 }, { orden: 2 }],
        [
          { desdeOrden: 0, hastaOrden: 1 },
          { desdeOrden: 1, hastaOrden: 2 },
        ],
      ),
    ).not.toThrow();
  });

  it('tramo legítimo "último stopover → destino" (n → n+1) → válido (FIX 1)', () => {
    // stopovers 1..2 → último stopover = 2, destino = 3. El tramo 2→3 (último tramo del viaje) DEBE pasar:
    // antes del fix (destino=max) este tramo apuntaba a un hito inexistente y se rechazaba indebidamente.
    expect(() =>
      assertTramosReferToValidStopovers(
        [{ orden: 1 }, { orden: 2 }],
        [{ desdeOrden: 2, hastaOrden: 3 }],
      ),
    ).not.toThrow();
  });

  it('hastaOrden apunta a un hito INEXISTENTE → ValidationError', () => {
    expect(() =>
      assertTramosReferToValidStopovers([{ orden: 1 }], [{ desdeOrden: 0, hastaOrden: 9 }]),
    ).toThrow(ValidationError);
  });

  it('desdeOrden apunta a un hito INEXISTENTE → ValidationError', () => {
    // stopovers {1} → hitos { 0, 1, 2 } (destino=2). desdeOrden=7 no existe → falla.
    expect(() =>
      assertTramosReferToValidStopovers([{ orden: 1 }], [{ desdeOrden: 7, hastaOrden: 2 }]),
    ).toThrow(ValidationError);
  });

  it('tramo que no avanza (desdeOrden >= hastaOrden) → ValidationError', () => {
    expect(() =>
      assertTramosReferToValidStopovers([{ orden: 1 }], [{ desdeOrden: 2, hastaOrden: 2 }]),
    ).toThrow(ValidationError);
  });
});
