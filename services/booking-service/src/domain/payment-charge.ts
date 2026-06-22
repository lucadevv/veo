/**
 * Dominio del borde de PAGO del carpooling (ADR-014 §5.3/§5.4). Vive en `domain/` (no en el adapter ni en el
 * service) porque son REGLAS, no transporte: la derivación determinista de la dedupKey financiera y el error
 * tipado del gate de deuda. CERO strings mágicos: el prefijo y el error son constantes/tipos del dominio.
 */
import { UnprocessableEntityError } from '@veo/utils';

/**
 * Prefijo de la dedupKey FINANCIERA del CHARGE del carpooling (§5.3). DISTINTO del `trip-completed:{tripId}`
 * del cobro on-demand y del `booking:req:` de la idempotencia de REQUEST (POST /bookings). Constante tipada,
 * un único punto define el namespace.
 */
const CHARGE_DEDUP_NAMESPACE = 'booking-charge:' as const;

/**
 * dedupKey financiera del CHARGE = `booking-charge:{bookingId}` (§5.3). DETERMINISTA por bookingId: un
 * reintento del cobro (mismo booking) reusa la MISMA key → payment NO duplica el cobro (idempotencia por
 * `dedupKey @unique`). Esto vuelve seguros los reintentos de BR-P02. Un timeout NUNCA crea un cobro nuevo:
 * el reintento manda la misma key.
 */
export function deriveBookingChargeDedupKey(bookingId: string): string {
  return `${CHARGE_DEDUP_NAMESPACE}${bookingId}`;
}

/**
 * El pasajero tiene deuda pendiente (cobros en PaymentStatus.DEBT · §5.4) → NO puede reservar (§5.2 paso 1).
 * Error de dominio TIPADO (no un string mágico ni un 500 opaco): 422 (precondición de negocio que falla,
 * sintaxis válida) — el BFF lo propaga limpio y la app muestra "saldá tu deuda para reservar". `details`
 * lleva el monto bloqueante para que la UI lo muestre sin una segunda llamada.
 */
export class PassengerHasDebtError extends UnprocessableEntityError {
  constructor(totalCents: number) {
    super('El pasajero tiene una deuda pendiente y no puede reservar hasta saldarla', {
      totalCents,
    });
  }
}
