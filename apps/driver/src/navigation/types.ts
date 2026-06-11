import type {NavigatorScreenParams} from '@react-navigation/native';

/**
 * Tabs principales del conductor (bottom tab bar "Midnight Motion").
 * Inicio = mapa + turno; Ganancias = finanzas; Viajes = historial; Cuenta = perfil.
 */
export type MainTabParamList = {
  Inicio: undefined;
  Ganancias: undefined;
  Viajes: undefined;
  Cuenta: undefined;
};

/**
 * Stack raíz del flujo del conductor. Las tabs viven bajo `Main`; las pantallas de viaje y de
 * turno se presentan por encima de las tabs (full-screen). Las que reciben datos del dispatch
 * declaran sus params reales (matchId/tripId).
 */
export type RootStackParamList = {
  Login: undefined;
  Onboarding: undefined;
  Registration: NavigatorScreenParams<RegistrationStackParamList>;
  UnderReview: undefined;
  Main: NavigatorScreenParams<MainTabParamList>;
  ShiftStart: undefined;
  BiometricEnroll: undefined;
  Documents: undefined;
  Incentives: undefined;
  /** Mis vehículos: lista + selección del activo (server) + alta de un vehículo nuevo (2do, moto). */
  Vehicles: undefined;
  Support: {tripId?: string} | undefined;
  TripIncoming: {matchId: string; tripId: string};
  TripActive: {tripId: string};
  /** Pujas abiertas (marketplace conductor): lista de bids cercanos a los que ofertar/contraofertar. */
  Bids: undefined;
  Chat: {tripId: string};
};

/**
 * Stack del wizard de registro (alta de socio conductor). Los 4 pasos se presentan con slide
 * horizontal; el estado de los datos vive en el store del feature, no en params.
 */
export type RegistrationStackParamList = {
  PersonalData: undefined;
  Vehicle: undefined;
  Documents: undefined;
  IdentityVerification: undefined;
};
