/**
 * Dominio del borde de PAGO del carpooling (ADR-014 §5.3/§5.4). Vive en `domain/` (no en el adapter ni en el
 * service) porque son REGLAS, no transporte: la derivación determinista de la dedupKey financiera y el error
 * tipado del gate de deuda. CERO strings mágicos: el prefijo y el error son constantes/tipos del dominio.
 */
import { UnprocessableEntityError } from '@veo/utils';
import { PaymentStatus } from '@veo/shared-types';

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

/**
 * El CHARGE del carpooling fue RECHAZADO de forma PERMANENTE — reintentar NUNCA va a funcionar (ADR-014 §5.4
 * "falla permanente → CANCELADO"). DOS orígenes, ambos terminales para ESTE booking:
 *   1. Decline SÍNCRONO: payment respondió HTTP 200 con `status` DEBT/FAILED (el cobro falló al iniciar, el
 *      adapter ya lo mapeó a PaymentStatus tipado). NO lanza — el service inspecciona `charge.status`.
 *   2. Error PERMANENTE: payment respondió un 4xx NO-reintentable (método inválido, pasajero bloqueado, etc.;
 *      EXCLUYE 408/429, que SÍ son transitorios). El adapter (`toExternalError`) lo clasifica y LANZA ESTO.
 *
 * Por qué un error de dominio PROPIO (httpStatus 422) y no el `ExternalServiceError` (502, reintentable): si
 * el booking se quedara con un 502 "reintentable", el conductor re-aprobaría → MISMA dedupKey → MISMO rechazo
 * → LOOP infinito sin salida terminal. Marcándolo PERMANENTE, `triggerCharge` lo atrapa y transiciona
 * APROBADO → CANCELADO (booking.cancelled, razon=COBRO_RECHAZADO): salida terminal, NO loop. `details.status`
 * lleva el PaymentStatus del decline (cuando vino por el camino 1); `cause`/`upstreamStatus`, el del 4xx.
 */
export class ChargePermanentlyRejectedError extends UnprocessableEntityError {
  constructor(details?: Record<string, unknown>) {
    super('El cobro del carpooling fue rechazado de forma permanente al dispararlo', details);
  }
}

/**
 * El `PaymentStatus` que devuelve `charge()` SÍNCRONAMENTE es un DECLINE permanente (el cobro falló al iniciar,
 * no es el camino async normal PENDING→captura). DEBT/FAILED son declines; PENDING (y un CAPTURED síncrono, raro
 * pero benigno) NO lo son. Predicado ÚNICO tipado (cero strings mágicos): el service decide la transición con
 * ESTO, no comparando literales. ADR-014 §5.4: DEBT/FAILED síncronos → CANCELADO.
 */
export function isSyncDeclineStatus(status: PaymentStatus): boolean {
  return status === PaymentStatus.DEBT || status === PaymentStatus.FAILED;
}
