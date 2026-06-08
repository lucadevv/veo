/**
 * Ruteo PURO de un deep-link de push (FCM). El payload `data` de FCM es SIEMPRE string→string, así que
 * acá traducimos esos strings a una ruta tipada del stack. Separar esta decisión del plumbing nativo
 * (navigationRef/getInitialNotification) la hace testeable sin emulador.
 *
 * Contrato del backend (notification-service): el push lleva `data: { tripId, screen? }`.
 *  - `screen` explícito (#1 PUJA programada → 'OffersBoard') gana, si está en la whitelist.
 *  - `screen: 'NoOffers'` (puja EXPIRED) → NO va a la pantalla legacy; aterriza en el HOME (`Main`/`Home`),
 *    donde el sheet unificado (RequestFlowScreen) rehidrata el viaje y la fase `noOffers` muestra
 *    `NoOffersBody`. El flujo normal vive ENTERO en el sheet (ver gap de hidratación EXPIRED abajo).
 *  - sin `screen` pero con `tripId` (assigned/expired) → cae a 'TripActive' (el detalle refleja cualquier estado).
 *  - sin `tripId` → null (no navegamos a ciegas).
 *
 * GAP HONESTO (hidratación EXPIRED): `useHydrateActiveTrip` consulta `/trips/active` (+ pending-settlement
 * COMPLETED), que NO incluye un viaje EXPIRED. Hoy la fase `noOffers` se alcanza EN VIVO dentro del sheet:
 * el `useOfferBoard`/socket del viaje en curso reporta `status: EXPIRED` mientras la app está abierta y la
 * puja sigue en memoria (`activeTripId`). Si la app se MATA y luego se toca el push de NoOffers, el sheet
 * aterriza en el Home pero NO re-hidrata el viaje EXPIRED (active devuelve null), así que la fase `noOffers`
 * NO se reconstruye desde frío. Cerrar ese caso requiere un endpoint de "puja rehidratable" (REBIDDABLE) en
 * `useHydrateActiveTrip` — queda como follow-up, no está resuelto.
 */

/** Pantallas LEGACY a las que un push aún hace deep-link directo. Reciben EXACTAMENTE `{ tripId }`. */
const TRIP_SCREENS = ['OffersBoard', 'TripActive'] as const;
type TripScreen = (typeof TRIP_SCREENS)[number];

/** Deep-link a una pantalla de viaje legacy (params `{ tripId }`). */
interface TripScreenTarget {
  screen: TripScreen;
  params: { tripId: string };
}

/**
 * Deep-link al HOME (sheet unificado). La puja EXPIRED (NoOffers) ya NO es una pantalla aparte: vive como
 * fase `noOffers` del sheet. El tripId NO viaja por navegación (el sheet hidrata desde el server); navegar
 * al tab Home alcanza para que el sheet re-entre al viaje en curso.
 */
interface HomeTarget {
  screen: 'Main';
  params: { screen: 'Home' };
}

export type DeepLinkTarget = TripScreenTarget | HomeTarget;

function isTripScreen(value: string | undefined): value is TripScreen {
  return value !== undefined && (TRIP_SCREENS as readonly string[]).includes(value);
}

export function resolveDeepLink(
  data: Record<string, string | object> | undefined,
): DeepLinkTarget | null {
  if (!data) return null;
  const tripId = typeof data.tripId === 'string' ? data.tripId : undefined;
  if (!tripId) return null;

  const screen = typeof data.screen === 'string' ? data.screen : undefined;

  // Puja EXPIRED: el flujo normal vive en el sheet → aterriza en el Home, no en la pantalla legacy.
  if (screen === 'NoOffers') {
    return { screen: 'Main', params: { screen: 'Home' } };
  }

  // `Counter` necesita driverId además de tripId; un push no lo lleva, así que no es destino directo.
  const target: TripScreen = isTripScreen(screen) ? screen : 'TripActive';
  return { screen: target, params: { tripId } };
}
