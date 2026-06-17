import { createNavigationContainerRef } from '@react-navigation/native';
import type { RootStackParamList } from './types';

/**
 * Ref global del contenedor de navegación. Permite navegar fuera del árbol de pantallas
 * (p. ej. desde `RealtimeManager` al recibir una oferta por el socket) sin acoplar a `useNavigation`.
 */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

/** Navega a la pantalla de oferta entrante si el contenedor ya está montado. */
export function navigateToIncoming(params: RootStackParamList['TripIncoming']): void {
  if (navigationRef.isReady()) {
    navigationRef.navigate('TripIncoming', params);
  }
}

/** Navega al board de pujas abiertas (ping de PUJA por el socket) si el contenedor ya está montado. */
export function navigateToBids(): void {
  if (navigationRef.isReady()) {
    navigationRef.navigate('Bids');
  }
}

/**
 * Navega a la pantalla del viaje activo. La usa la REHIDRATACIÓN tras un reinicio: si el conductor mató
 * la app mid-viaje, al reabrir se lo devuelve a su viaje en curso (y el publisher de seguridad se
 * reanuda, regla #4). `navigate` (no `reset`) preserva el back-stack hacia el dashboard.
 */
export function navigateToTripActive(tripId: string): void {
  if (navigationRef.isReady()) {
    navigationRef.navigate('TripActive', { tripId });
  }
}
