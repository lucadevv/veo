import type { NavigatorScreenParams } from '@react-navigation/native';
import type { TripHistoryItem } from '@veo/api-client';

/**
 * Tabs principales del conductor (bottom tab bar). Híbrido: DOS modos de ganar first-class —
 * Inicio = on-demand (mapa + turno, tiempo real); Compartir = carpooling (publicar viaje programado +
 * gestionar reservas, marketplace). Ganancias = finanzas; Viajes = historial; Cuenta = perfil.
 */
export type MainTabParamList = {
  Inicio: undefined;
  Compartir: undefined;
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
  /** Alta RECHAZADA: muestra el motivo + corregir-y-reenviar (resubmit). Fuera del grupo wizard. */
  Rejected: undefined;
  /**
   * Reintento del gate de alta: el perfil del conductor (`GET /drivers/me`) no resolvió por un error
   * NO definitivo (red / 5xx) y nunca se resolvió antes. La sesión sigue válida; se ofrece reintentar.
   */
  RegistrationGateRetry: undefined;
  Main: NavigatorScreenParams<MainTabParamList>;
  ShiftStart: undefined;
  /**
   * Gate al iniciar turno (frame C/Turno-DocsVencidos): el vehículo/conductor tiene un documento
   * BLOQUEANTE (vencido/rechazado) → no se puede iniciar turno. El dashboard enruta aquí antes de
   * `ShiftStart` cuando detecta docs bloqueantes; el CTA lleva a Documentos a actualizarlos.
   */
  ShiftBlocked: undefined;
  /**
   * Permiso de ubicación denegado (frame C/Permiso-Ubicacion): pantalla dedicada que se presenta
   * cuando el conductor intenta conectarse sin permiso de GPS. "Abrir Ajustes" → SO; "Ahora no" → atrás.
   */
  LocationPermission: undefined;
  /**
   * Resumen de CIERRE de turno (frame C/CierreTurno): tras finalizar el turno, celebra el cierre y muestra
   * lo ganado hoy + stats. `shiftStartedAt` es la marca de inicio LOCAL (epoch ms) para calcular la
   * duración; `null` si no se pudo medir (degrada a "—"). Terminal: se sale con "Ver ganancias" o "Listo".
   */
  ShiftSummary: { shiftStartedAt: number | null };
  BiometricEnroll: undefined;
  /** Editar perfil del conductor (frame C/Editar-Perfil): datos de contacto + foto. */
  EditProfile: undefined;
  Documents: undefined;
  Incentives: undefined;
  /** Centro de avisos (feed in-app): bandeja de notificaciones del conductor. */
  Notifications: undefined;
  /** Mis vehículos: lista + selección del activo (server) + alta de un vehículo nuevo (2do, moto). */
  Vehicles: undefined;
  Support: { tripId?: string } | undefined;
  TripActive: { tripId: string };
  /**
   * Cierre del viaje: resumen de ganancia (tarifa − comisión = neto) + calificar al pasajero. Se llega
   * al COMPLETAR (reemplaza a TripActive). `fareCents`/`passengerId`/`paymentMethod` vienen del viaje ya
   * cargado en TripActive; `passengerName` es opcional (el contrato del viaje no lo trae — pregunta genérica
   * si falta). `paymentMethod` decide si el cierre muestra la card de confirmación de cobro en efectivo.
   */
  TripComplete: {
    tripId: string;
    passengerId: string;
    fareCents: number;
    paymentMethod: string;
    passengerName?: string;
  };
  /**
   * Detalle/recibo de un viaje del HISTORIAL (frame C/Historial-Detalle). Recibe el `TripHistoryItem`
   * COMPLETO que la fila ya cargó (origen/destino, distancia, duración, fecha, tarifa, tier) — la fuente
   * REAL del recibo. El `GET /trips/:id` (driverTripView) es MÁS POBRE que este item (no trae coords ni
   * fecha ni tier), así que reusarlo degradaría la pantalla; el rating dado se resuelve on-demand por
   * `id`. Sin PII: el nombre del pasajero no viaja en el contrato (regla #5) → se degrada a genérico.
   */
  TripDetail: { trip: TripHistoryItem };
  /** Pujas abiertas (marketplace conductor): lista de bids cercanos a los que ofertar/contraofertar. */
  Bids: undefined;
  Chat: { tripId: string };
  /**
   * ADR-022 §P-A · Saldar la deuda de comisiones (viajes en efectivo sobre el tope): total pendiente +
   * elegir medio digital → cobro de liquidación → checkout → desbloqueo. Se llega desde el banner de bloqueo
   * del dashboard y desde la fila "Debés a VEO" de Ganancias. Es la ÚNICA forma de desbloquearse.
   */
  SettleDebt: undefined;
  /** Carpooling: publicar un viaje compartido (ruta + fecha + asientos + precio con tope anti-lucro). */
  CarpoolPublish: undefined;
  /** Carpooling: gestionar las solicitudes de un viaje publicado (aprobar/rechazar). */
  CarpoolTripBookings: { tripId: string };
};

/**
 * Stack del wizard de registro (alta de socio conductor). Los 3 pasos se presentan con slide
 * horizontal; el estado de los datos vive en el store del feature, no en params. LOTE B: el paso
 * Documents desapareció (los docs se reagrupan por dueño: licencia→Conductor, SOAT→Vehículo).
 */
export type RegistrationStackParamList = {
  PersonalData: undefined;
  Vehicle: undefined;
  IdentityVerification: undefined;
};
