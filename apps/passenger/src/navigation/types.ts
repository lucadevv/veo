/**
 * Tipado de la navegación del pasajero.
 * Flujo: Splash → (Onboarding | Auth) → Home (raíz autenticada) → pantallas de viaje/seguridad/pago.
 *
 * REFACTOR navegación (sin bottom tabs): se eliminó el tab navigator de 3 tabs. `Home` es ahora la
 * pantalla RAÍZ del stack autenticado; `Profile` se alcanza por el avatar del header del Home y
 * `TripHistory` ("Mis viajes") vive como entrada del Perfil. Por eso `Home`/`TripHistory`/`Profile`
 * pasan a ser rutas DIRECTAS del `RootStackParamList` (antes vivían en `MainTabParamList` bajo `Main`).
 * `Main`/`MainTabParamList` se eliminaron (ya no hay tabs ni navegación anidada que tipar).
 */

/**
 * BÚSQUEDA de carpooling (P/ProgSearch → P/ProgResults): viaja por params entre las pantallas del
 * flujo (results → detail → review) para que cada una sea rehidratable por sí sola. Los labels son
 * los textos que el pasajero eligió en el autocompletado (se muestran tal cual, sin re-geocodificar).
 */
export interface CarpoolSearchQuery {
  originLat: number;
  originLon: number;
  originLabel: string;
  destLat: number;
  destLon: number;
  destLabel: string;
  /** Día calendario buscado (YYYY-MM-DD, local). */
  fecha: string;
  /** Asientos que el pasajero necesita (1..8). */
  asientos: number;
}

/** Stack raíz que envuelve onboarding, auth, el Home autenticado y las pantallas modales/de viaje. */
export type RootStackParamList = {
  Splash: undefined;
  Onboarding: undefined;
  Auth: undefined;
  CompleteProfile: undefined;
  /** Bottom nav autenticado (Inicio·Viajes·Seguridad·Cuenta) — design/veo.pen C/TabBar. */
  Main: undefined;
  /** Tab Seguridad (hub). Renderiza dentro de `Main`; acá para tipar navigate('Seguridad'). */
  Seguridad: undefined;
  /** Sesión expirada por inactividad: re-verificar identidad (el trigger es follow-up). */
  SessionExpired: undefined;
  /** Pantalla RAÍZ autenticada (antes el tab Home): `RequestFlowScreen` con el mapa + sheet del flujo. */
  Home: undefined;
  /** "Mis viajes" (antes tab): alcanzable desde el Perfil. Lista paginada + detalle en sheet. */
  TripHistory: undefined;
  /** Perfil del pasajero (antes tab): se alcanza por el avatar del header del Home. */
  Profile: undefined;
  /**
   * Buscador de origen/destino. Siempre abierto DESDE el sheet unificado (RequestFlowScreen/QuotingBody):
   * al fijar AMBOS extremos hace `goBack()` al sheet, que sigue en fase `quoting` con el borrador
   * actualizado. `flow: 'sheet'` es el único valor (se conserva como marca de intención del caller).
   */
  Search: {flow?: 'sheet'} | undefined;
  /** Elegir un punto (recojo/destino/parada) arrastrando el mapa bajo un pin fijo. Aplica al `editing`. */
  MapPick: undefined;
  /** PUJA · board de ofertas en vivo tras crear la puja (ADR 010). */
  OffersBoard: {tripId: string};
  /** PUJA · detalle de la contraoferta de UN conductor (aceptar / esperar). */
  Counter: {tripId: string; driverId: string};
  /** PUJA · puja sin ofertas (EXPIRED): re-pujar más alto para reabrir el board. */
  NoOffers: {tripId: string};
  TripActive: {tripId: string};
  /** "Comparte tu viaje" (design/veo.pen zKyic): enlace de seguimiento + canales + contactos. */
  FamilyShare: {tripId: string};
  /** Cámara del viaje a pantalla completa (Ola 2A · seguridad). */
  CameraLive: {tripId: string};
  /** Control de privacidad: quién puede ver la cámara del viaje (Ola 2A). */
  CameraControl: {tripId: string};
  // El DETALLE de un viaje terminal YA NO es una pantalla (`TripDetail` eliminado): vive en un
  // `DraggableSheet` SOBRE "Mis Viajes" (ver TripDetailSheet). No hay ruta ni params que tipar.
  ScheduledTrips: undefined;
  /** Programar un viaje nuevo (entrada al flujo real de programación desde "+"). */
  ScheduleNew: undefined;
  /** Carpooling (ADR-014 · pen sección 5): buscador de asientos publicados entre ciudades. */
  CarpoolSearch: undefined;
  /** Carpooling: resultados keyset de la búsqueda (la query viaja completa en params). */
  CarpoolResults: {search: CarpoolSearchQuery};
  /** Carpooling: detalle enriquecido de un viaje publicado (driver/vehicle pueden venir null). */
  CarpoolTripDetail: {tripId: string; search: CarpoolSearchQuery};
  /** Carpooling: revisión de la reserva (asientos, mensaje, método de pago) antes del POST. */
  CarpoolBookingReview: {tripId: string; search: CarpoolSearchQuery};
  /** Carpooling: estado REAL de MI solicitud (poll hasta que el conductor decida). */
  CarpoolBookingStatus: {bookingId: string};
  /** Centro de avisos del pasajero (campana del Home). Título "Avisos" (el FEED). */
  Notifications: undefined;
  /** Preferencias de notificaciones (pen P/NotifPrefs): toggles por categoría, persistencia local. */
  NotificationPrefs: undefined;
  /** Reasignación: el conductor canceló (estado REASSIGNING) → reabre el board de ofertas. */
  Reassign: {tripId: string};
  /** Reportar un objeto olvidado de un viaje (vía ticket de soporte). */
  LostItem: {tripId: string};
  /**
   * Pantalla manual de pánico. `escalated: true` cuando llega por ESCALAMIENTO del disparo
   * silencioso fallido (SilentPanicDispatcher agotó reintentos): la pantalla arranca avisando
   * que la alerta oculta NO se envió, en vez del estado neutro "¿Necesitas ayuda?".
   */
  Panic: {tripId: string; escalated?: boolean};
  TrustedContacts: undefined;
  ChildMode: undefined;
  KycCamera: undefined;
  PaymentMethods: undefined;
  Payment: {tripId: string; amountCents: number; driverId?: string};
  Rating: {tripId: string; driverId: string};
  SavedPlaces: undefined;
  Referrals: undefined;
  Chat: {tripId: string; driverName?: string};
  Help: undefined;
};

/** ParamList de las tabs del bottom nav (`MainTabs`). Home/TripHistory/Profile también quedan en
 * `RootStackParamList` para que `navigate('Home')` etc. sigan tipando (resuelven a la tab anidada). */
export type MainTabsParamList = {
  Home: undefined;
  TripHistory: undefined;
  Seguridad: undefined;
  Profile: undefined;
};

/** Habilita el tipado global de `useNavigation()` sin pasar genéricos en cada uso. */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends RootStackParamList {}
  }
}
