import type { NavigatorScreenParams } from '@react-navigation/native';

/**
 * Tipado de la navegación del pasajero.
 * Flujo: Splash → (Onboarding | Auth) → Main (tabs) → pantallas de viaje/seguridad/pago.
 */

/** Tabs principales tras autenticar. */
export type MainTabParamList = {
  Home: undefined;
  TripHistory: undefined;
  Profile: undefined;
};

/** Stack raíz que envuelve onboarding, auth, tabs y las pantallas modales/de viaje. */
export type RootStackParamList = {
  Splash: undefined;
  Onboarding: undefined;
  Auth: undefined;
  CompleteProfile: undefined;
  BiometricLock: undefined;
  /** Sesión expirada por inactividad: re-verificar identidad (el trigger es follow-up). */
  SessionExpired: undefined;
  Main: NavigatorScreenParams<MainTabParamList>;
  /**
   * Buscador de origen/destino. `flow` decide a dónde vuelve al fijar AMBOS extremos:
   *  - `'sheet'`: abierto DESDE el sheet unificado (RequestFlowScreen/QuotingBody) → `goBack()` al
   *    sheet, que sigue en fase `quoting` con el borrador actualizado. NO navega a RouteQuote.
   *  - `'quote'` (default): callers LEGACY/no migrados (flujo PROGRAMADO `ScheduleNew`) → navega a
   *    `RouteQuote`. Es el default a propósito para no romper esos callers.
   */
  Search: { flow?: 'sheet' | 'quote' } | undefined;
  RouteQuote: undefined;
  /** PUJA · board de ofertas en vivo tras crear la puja (ADR 010). */
  OffersBoard: { tripId: string };
  /** PUJA · detalle de la contraoferta de UN conductor (aceptar / esperar). */
  Counter: { tripId: string; driverId: string };
  /** PUJA · puja sin ofertas (EXPIRED): re-pujar más alto para reabrir el board. */
  NoOffers: { tripId: string };
  TripActive: { tripId: string };
  /** Cámara del viaje a pantalla completa (Ola 2A · seguridad). */
  CameraLive: { tripId: string };
  /** Control de privacidad: quién puede ver la cámara del viaje (Ola 2A). */
  CameraControl: { tripId: string };
  // El DETALLE de un viaje terminal YA NO es una pantalla (`TripDetail` eliminado): vive en un
  // `DraggableSheet` SOBRE "Mis Viajes" (ver TripDetailSheet). No hay ruta ni params que tipar.
  ScheduledTrips: undefined;
  /** Programar un viaje nuevo (entrada al flujo real de programación desde "+"). */
  ScheduleNew: undefined;
  /** Centro de avisos del pasajero (campana del Home). */
  Notifications: undefined;
  /** Reasignación: el conductor canceló (estado REASSIGNING) → reabre el board de ofertas. */
  Reassign: { tripId: string };
  /** Reportar un objeto olvidado de un viaje (vía ticket de soporte). */
  LostItem: { tripId: string };
  Panic: { tripId: string };
  TrustedContacts: undefined;
  ChildMode: undefined;
  KycCamera: undefined;
  PaymentMethods: undefined;
  Payment: { tripId: string; amountCents: number; driverId?: string };
  Rating: { tripId: string; driverId: string };
  SavedPlaces: undefined;
  Referrals: undefined;
  Chat: { tripId: string };
  Help: undefined;
};

/** Habilita el tipado global de `useNavigation()` sin pasar genéricos en cada uso. */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends RootStackParamList {}
  }
}
