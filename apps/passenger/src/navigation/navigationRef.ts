import { createNavigationContainerRef } from '@react-navigation/native';
import type { RootStackParamList } from './types';

/**
 * Ref global del NavigationContainer. Permite navegar DESDE FUERA de React (handlers de push FCM, que
 * corren en el bootstrap nativo, sin acceso al árbol de componentes). Lo consume `messaging.ts` para el
 * deep-link al tocar una notificación. `isReady()` evita navegar antes de que el contenedor monte.
 */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();
