import { describe, it, expect } from 'vitest';
import { PublishedTripState } from '../generated/prisma';
import { InvalidStatusTransition } from './state-machine';
import { publishedTripMachine } from './published-trip-state';

const ALL_STATES = Object.values(PublishedTripState);

/**
 * Transiciones válidas esperadas, declaradas INDEPENDIENTES de la tabla de producción para no
 * tautologizar el test (espejo de driver-status.spec). from === to (idempotente) se cubre aparte en
 * el bucle. Si la tabla de la máquina cambia, este set DEBE cambiar — eso es la red de seguridad.
 */
const EXPECTED_VALID = new Set<string>([
  // publicar
  `${PublishedTripState.BORRADOR}->${PublishedTripState.PUBLICADO}`,
  // ciclo de reservas (decremento de asientos, §6)
  `${PublishedTripState.PUBLICADO}->${PublishedTripState.PARCIALMENTE_RESERVADO}`,
  `${PublishedTripState.PUBLICADO}->${PublishedTripState.LLENO}`,
  `${PublishedTripState.PARCIALMENTE_RESERVADO}->${PublishedTripState.LLENO}`,
  // libera asiento (cancela un pasajero)
  `${PublishedTripState.LLENO}->${PublishedTripState.PARCIALMENTE_RESERVADO}`,
  // arranque del viaje (al llegar fechaHoraSalida) desde cualquier estado con cupo
  `${PublishedTripState.PUBLICADO}->${PublishedTripState.EN_RUTA}`,
  `${PublishedTripState.PARCIALMENTE_RESERVADO}->${PublishedTripState.EN_RUTA}`,
  `${PublishedTripState.LLENO}->${PublishedTripState.EN_RUTA}`,
  // fin del viaje
  `${PublishedTripState.EN_RUTA}->${PublishedTripState.COMPLETADO}`,
  // cancelación desde cualquier estado PRE-viaje
  `${PublishedTripState.BORRADOR}->${PublishedTripState.CANCELADO}`,
  `${PublishedTripState.PUBLICADO}->${PublishedTripState.CANCELADO}`,
  `${PublishedTripState.PARCIALMENTE_RESERVADO}->${PublishedTripState.CANCELADO}`,
  `${PublishedTripState.LLENO}->${PublishedTripState.CANCELADO}`,
]);

describe('Eje PublishedTrip.estado · cobertura del producto cartesiano', () => {
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      const shouldBeValid = from === to || EXPECTED_VALID.has(`${from}->${to}`);

      it(`${from} → ${to} ${shouldBeValid ? 'es válida' : 'es inválida'}`, () => {
        expect(publishedTripMachine.canTransition(from, to)).toBe(shouldBeValid);
        if (shouldBeValid) {
          expect(() => publishedTripMachine.assertTransition(from, to)).not.toThrow();
        } else {
          expect(() => publishedTripMachine.assertTransition(from, to)).toThrow(
            InvalidStatusTransition,
          );
        }
      });
    }
  }

  it('la oferta SOLO se publica desde BORRADOR (PUBLICADO → BORRADOR es inválida)', () => {
    expect(
      publishedTripMachine.canTransition(PublishedTripState.BORRADOR, PublishedTripState.PUBLICADO),
    ).toBe(true);
    expect(
      publishedTripMachine.canTransition(PublishedTripState.PUBLICADO, PublishedTripState.BORRADOR),
    ).toBe(false);
  });

  it('COMPLETADO y CANCELADO son terminales (sin salida)', () => {
    for (const to of ALL_STATES) {
      if (to === PublishedTripState.COMPLETADO) continue; // from===to idempotente
      expect(publishedTripMachine.canTransition(PublishedTripState.COMPLETADO, to)).toBe(false);
    }
    for (const to of ALL_STATES) {
      if (to === PublishedTripState.CANCELADO) continue;
      expect(publishedTripMachine.canTransition(PublishedTripState.CANCELADO, to)).toBe(false);
    }
  });

  it('no se cancela un viaje ya EN_RUTA (EN_RUTA → CANCELADO es inválida)', () => {
    expect(
      publishedTripMachine.canTransition(PublishedTripState.EN_RUTA, PublishedTripState.CANCELADO),
    ).toBe(false);
  });

  it('un estado legacy fuera del enum es inválido hacia TODO destino (fail-closed)', () => {
    const legacy = 'LEGACY_GARBAGE' as PublishedTripState;
    for (const to of ALL_STATES) {
      expect(publishedTripMachine.canTransition(legacy, to)).toBe(false);
      expect(() => publishedTripMachine.assertTransition(legacy, to)).toThrow(
        InvalidStatusTransition,
      );
    }
  });
});
