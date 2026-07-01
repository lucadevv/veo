import type { DispatchOutcome } from '../enums/index.js';

/**
 * TTL (segundos) del registro de ubicación de un conductor en el hot-index de dispatch: si no
 * pinguea dentro de esta ventana deja de ser candidato al matching Y deja de estar "en línea" (BR-T06).
 *
 * FUENTE ÚNICA de verdad (evita el número mágico duplicado entre backend y web):
 *  - dispatch-service la usa como default de su env `DRIVER_LOC_TTL_SECONDS` (ajustable por entorno).
 *  - admin-web deriva de ella la ventana de poda de markers stale del mapa `/ops`, de modo que el
 *    cliente saque a un conductor desconectado con la MISMA semántica que el hot-index del backend
 *    (un marker no puede sobrevivir a la expiración del registro que lo alimenta).
 * Es el contrato POR-DEFECTO: si un operador sube el env en el backend, esta constante sigue siendo
 * el valor de referencia; el cliente aplica un colchón sobre ella para nunca podar a alguien vivo.
 */
export const DRIVER_LOC_TTL_SECONDS_DEFAULT = 60;

/** Oferta de viaje a un conductor durante el matching (BR-T06). */
export interface DispatchMatch {
  id: string;
  tripId: string;
  driverId: string;
  score: number;
  attempt: number;
  offeredAt: Date;
  respondedAt?: Date;
  outcome: DispatchOutcome;
}
