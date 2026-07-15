import { useCallback } from 'react';
import { BackHandler, type NativeEventSubscription } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

/**
 * Guarda del botón "Atrás" de hardware de Android (LOTE 1, #5) para las pantallas RAÍZ del onboarding
 * que NO tienen back de navegación (paso 1 del wizard, "En revisión", "Rechazado" y el reintento del
 * gate). Sin esto, el back de hardware CIERRA la app —no hay paso anterior al que volver—. Acá lo
 * interceptamos y delegamos en `onBack` (típicamente `handleHardwareBack` de `useRegistrationExit`),
 * devolviendo `true` para consumir el evento y evitar que Android cierre la app.
 *
 * El guard es TONTO a propósito (SRP): solo intercepta y consume el evento. La decisión de qué hacer
 * (abrir el confirm si está cerrado, o cerrarlo si ya está abierto) vive en el hook, no acá.
 *
 * Se monta solo mientras la pantalla está enfocada (`useFocusEffect`) y se desuscribe al perder foco,
 * para no interceptar el back de otras pantallas. NO aplicar en los pasos 2/3/4 del wizard: ahí el back
 * debe seguir yendo a `navigation.goBack()` (paso anterior), que es el comportamiento por defecto.
 *
 * @param onBack Acción a ejecutar cuando el usuario presiona el back de hardware (típicamente
 *   `handleHardwareBack`: toggle del confirm de salida).
 * @param enabled Si `false`, el guard NO registra el handler (no consume el back). Sirve para las pantallas
 *   de paso EMBEBIDAS en el wizard de un solo screen: ahí el guard lo monta el HOST, y montarlo también en la
 *   página produciría un doble handler de hardware-back. Por defecto `true` (los callers raíz no cambian).
 */
export function useRegistrationExitGuard(onBack: () => void, enabled = true): void {
  useFocusEffect(
    useCallback(() => {
      if (!enabled) {
        return undefined;
      }
      const subscription: NativeEventSubscription = BackHandler.addEventListener(
        'hardwareBackPress',
        () => {
          onBack();
          // `true` = evento consumido: Android NO cierra la app ni navega hacia atrás.
          return true;
        },
      );
      return () => subscription.remove();
    }, [onBack, enabled]),
  );
}
