import { describe, it, expect } from 'vitest';
import { BookingState } from '../generated/prisma';
import { InvalidStatusTransition } from './state-machine';
import { bookingMachine } from './booking-state';

const ALL_STATES = Object.values(BookingState);

/**
 * Transiciones válidas esperadas, declaradas INDEPENDIENTES de la tabla de producción (espejo de
 * driver-status.spec). Si la tabla cambia, este set DEBE cambiar. Cubre el corazón del ADR-014 §4.2:
 * el camino APROBADO → COBRO_PENDIENTE → CONFIRMADO (cobro async) y los terminales sin cobro.
 */
const EXPECTED_VALID = new Set<string>([
  // creación
  `${BookingState.SOLICITADO}->${BookingState.PENDIENTE_APROBACION}`, // modo REVISION
  `${BookingState.SOLICITADO}->${BookingState.APROBADO}`, // modo INSTANT (salta)
  `${BookingState.SOLICITADO}->${BookingState.CANCELADO}`,
  // revisión del conductor
  `${BookingState.PENDIENTE_APROBACION}->${BookingState.APROBADO}`,
  `${BookingState.PENDIENTE_APROBACION}->${BookingState.RECHAZADO}`,
  `${BookingState.PENDIENTE_APROBACION}->${BookingState.EXPIRADO}`,
  `${BookingState.PENDIENTE_APROBACION}->${BookingState.CANCELADO}`,
  // cobro async (charge-on-approval SIN hold)
  `${BookingState.APROBADO}->${BookingState.COBRO_PENDIENTE}`,
  `${BookingState.APROBADO}->${BookingState.CANCELADO}`,
  `${BookingState.COBRO_PENDIENTE}->${BookingState.CONFIRMADO}`, // payment.captured
  `${BookingState.COBRO_PENDIENTE}->${BookingState.CANCELADO}`, // payment.failed / asiento-lleno → Refund
  // viaje
  `${BookingState.CONFIRMADO}->${BookingState.EN_RUTA}`,
  `${BookingState.CONFIRMADO}->${BookingState.CANCELADO}`,
  `${BookingState.EN_RUTA}->${BookingState.COMPLETADO}`,
]);

describe('Eje Booking.estado · cobertura del producto cartesiano', () => {
  for (const from of ALL_STATES) {
    for (const to of ALL_STATES) {
      const shouldBeValid = from === to || EXPECTED_VALID.has(`${from}->${to}`);

      it(`${from} → ${to} ${shouldBeValid ? 'es válida' : 'es inválida'}`, () => {
        expect(bookingMachine.canTransition(from, to)).toBe(shouldBeValid);
        if (shouldBeValid) {
          expect(() => bookingMachine.assertTransition(from, to)).not.toThrow();
        } else {
          expect(() => bookingMachine.assertTransition(from, to)).toThrow(InvalidStatusTransition);
        }
      });
    }
  }

  it('el cobro async pasa SIEMPRE por COBRO_PENDIENTE (APROBADO no salta a CONFIRMADO)', () => {
    // El corazón de la corrección consciente del ADR-014 §5: NO hay APROBADO→CONFIRMADO directo.
    expect(bookingMachine.canTransition(BookingState.APROBADO, BookingState.CONFIRMADO)).toBe(false);
    expect(bookingMachine.canTransition(BookingState.APROBADO, BookingState.COBRO_PENDIENTE)).toBe(
      true,
    );
    expect(
      bookingMachine.canTransition(BookingState.COBRO_PENDIENTE, BookingState.CONFIRMADO),
    ).toBe(true);
  });

  it('INSTANT salta PENDIENTE_APROBACION (SOLICITADO → APROBADO es válida)', () => {
    expect(bookingMachine.canTransition(BookingState.SOLICITADO, BookingState.APROBADO)).toBe(true);
  });

  it('RECHAZADO y EXPIRADO son terminales sin cobro (sin salida)', () => {
    for (const to of ALL_STATES) {
      if (to !== BookingState.RECHAZADO) {
        expect(bookingMachine.canTransition(BookingState.RECHAZADO, to)).toBe(false);
      }
      if (to !== BookingState.EXPIRADO) {
        expect(bookingMachine.canTransition(BookingState.EXPIRADO, to)).toBe(false);
      }
    }
  });

  it('no se confirma una reserva no aprobada (SOLICITADO → CONFIRMADO es inválida)', () => {
    expect(bookingMachine.canTransition(BookingState.SOLICITADO, BookingState.CONFIRMADO)).toBe(
      false,
    );
  });

  it('un estado legacy fuera del enum es inválido hacia TODO destino (fail-closed)', () => {
    const legacy = 'LEGACY_GARBAGE' as BookingState;
    for (const to of ALL_STATES) {
      expect(bookingMachine.canTransition(legacy, to)).toBe(false);
      expect(() => bookingMachine.assertTransition(legacy, to)).toThrow(InvalidStatusTransition);
    }
  });
});
