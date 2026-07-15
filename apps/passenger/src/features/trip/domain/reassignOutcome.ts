import type {TripStatus} from '@veo/api-client';

/**
 * Qué hace la pantalla de Reasignación ante el estado REAL del viaje (poll `GET /trips/:id/state`):
 *  - `stay`         → seguir mostrando "buscando otro conductor" (estado esperado de la pantalla).
 *  - `adoptAndHome` → re-adoptar el viaje en el `activeTripStore` y volver al Home: el flujo unificado
 *                     retoma la fase viva (conductor asignado) o reconstruye la terminal re-accionable
 *                     (EXPIRED → noDriver/noOffers) vía su propio poll.
 *  - `homeOnly`     → volver al Home SIN adoptar: el viaje está muerto (no hay fase que retomar).
 */
export type ReassignOutcome = 'stay' | 'adoptAndHome' | 'homeOnly';

/**
 * Decisión PURA del ruteo de la pantalla de Reasignación. Existe porque la pantalla era ESTÁTICA: si la
 * re-búsqueda expiraba (EXPIRED) o si OTRO conductor aceptaba (ASSIGNED/…), el pasajero quedaba clavado
 * en "buscando otro conductor" PARA SIEMPRE — llegó con `clearTrip()` hecho (activeTripId=null), así que
 * ningún otro mecanismo lo rescataba. Total sobre el enum: cada estado decide explícito.
 */
export function resolveReassignOutcome(
  status: TripStatus | null | undefined,
): ReassignOutcome {
  switch (status) {
    // Sin dato todavía (primer poll en vuelo o error transitorio): no decidir nada.
    case null:
    case undefined:
      return 'stay';
    // Estado esperado de la pantalla: la re-búsqueda sigue abierta.
    case 'REASSIGNING':
      return 'stay';
    // SCHEDULED no es alcanzable desde REASSIGNING; si apareciera, quedarse es lo inocuo.
    case 'SCHEDULED':
      return 'stay';
    // La búsqueda volvió a abrirse como puja/búsqueda normal → el flujo unificado la muestra (searching).
    case 'REQUESTED':
    case 'MATCHING':
      return 'adoptAndHome';
    // Un conductor aceptó la re-oferta → retomar la fase viva del flujo unificado.
    case 'ASSIGNED':
    case 'ACCEPTED':
    case 'ARRIVING':
    case 'ARRIVED':
    case 'IN_PROGRESS':
      return 'adoptAndHome';
    // La re-búsqueda cerró sin candidatos: EXPIRED NO es terminal-muerto (re-puja / noDriver): el flujo
    // unificado reconstruye esa fase desde el server, igual que el deep-link de NoOffers.
    case 'EXPIRED':
      return 'adoptAndHome';
    // COMPLETED no es alcanzable pre-recojo, pero si llegara, el flujo unificado re-ofrece el cierre.
    case 'COMPLETED':
      return 'adoptAndHome';
    // Viaje muerto: no hay nada que retomar.
    case 'CANCELLED':
    case 'FAILED':
      return 'homeOnly';
  }
}
