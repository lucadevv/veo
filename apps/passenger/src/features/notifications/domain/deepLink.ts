/**
 * Ruteo PURO de un deep-link de push (FCM). El payload `data` de FCM es SIEMPRE string→string, así que
 * acá traducimos esos strings a una ruta tipada del stack. Separar esta decisión del plumbing nativo
 * (navigationRef/getInitialNotification) la hace testeable sin emulador.
 *
 * Contrato del backend (notification-service): el push lleva `data: { tripId, screen? }`.
 *  - `screen: 'OffersBoard'` (#1 PUJA programada) es la ÚNICA pantalla legacy que sigue siendo destino
 *    directo (whitelist), con params `{ tripId }`.
 *  - CUALQUIER otro push con `tripId` (assigned/expired/NoOffers/el viejo 'TripActive') aterriza en el
 *    HOME con `adoptTripId`: quien navega ADOPTA el viaje en el `activeTripStore` y el flujo UNIFICADO
 *    (RequestFlowScreen + resolveTripPhase) re-deriva la fase real — viaje vivo, EXPIRED ('noOffers'),
 *    o COMPLETED (re-entrada al cierre). La pantalla legacy `TripActive` se ELIMINÓ: duplicaba la UI del
 *    viaje, abría el socket sin gate (loop de handshakes rechazados en un viaje COMPLETED) y dependía de
 *    un snapshot MMKV local que un push sin historial no tiene (mapa sin ruta ni markers).
 *  - sin `tripId` → null (no navegamos a ciegas).
 *
 * Nota (hidratación EXPIRED): adoptar el `tripId` del push cierra el gap de arranque en frío — el poll
 * de estado del sheet (`GET /trips/:id/state`) reporta EXPIRED y la fase `noOffers` se reconstruye sin
 * depender de `GET /trips/active` (que no incluye un viaje EXPIRED).
 */

/** Pantallas LEGACY a las que un push aún hace deep-link directo. Reciben EXACTAMENTE `{ tripId }`. */
const TRIP_SCREENS = ['OffersBoard'] as const;
type TripScreen = (typeof TRIP_SCREENS)[number];

/** Deep-link a una pantalla de viaje legacy (params `{ tripId }`). */
interface TripScreenTarget {
  screen: TripScreen;
  params: {tripId: string};
}

/**
 * Deep-link al HOME (sheet unificado). `adoptTripId` es el viaje del push: quien navega lo ADOPTA en el
 * `activeTripStore` ANTES de aterrizar, y la máquina de fases del sheet hace el resto (el estado real
 * viene del server por poll/socket; el tripId NO viaja por params de navegación).
 */
interface HomeTarget {
  screen: 'Home';
  adoptTripId?: string;
}

export type DeepLinkTarget = TripScreenTarget | HomeTarget;

function isTripScreen(value: string | undefined): value is TripScreen {
  return (
    value !== undefined && (TRIP_SCREENS as readonly string[]).includes(value)
  );
}

export function resolveDeepLink(
  data: Record<string, string | object> | undefined,
): DeepLinkTarget | null {
  if (!data) return null;
  const tripId = typeof data.tripId === 'string' ? data.tripId : undefined;
  if (!tripId) return null;

  const screen = typeof data.screen === 'string' ? data.screen : undefined;

  if (isTripScreen(screen)) {
    return {screen, params: {tripId}};
  }

  // Todo lo demás (NoOffers, el viejo 'TripActive', sin screen): el flujo unificado del Home adopta el
  // viaje y su fase real. `Counter` necesita driverId además de tripId; un push no lo lleva.
  return {screen: 'Home', adoptTripId: tripId};
}
