import { AppState, Platform, type AppStateStatus } from 'react-native';
import { focusManager } from '@tanstack/react-query';

/**
 * Cablea el `focusManager` de React Query al `AppState` de React Native.
 *
 * React Query, por defecto, revalida las queries con `refetchOnWindowFocus` cuando la ventana RECUPERA
 * el foco — un concepto que RN no tiene (por eso `queryClient` lo dejó en `false` global). Su equivalente
 * en mobile es que la app vuelva a `active` (de background a primer plano). Sin este puente, una query
 * marcada con `refetchOnWindowFocus` NUNCA se revalida al traer la app al frente, justo cuando el
 * conductor la vuelve a mirar tras tenerla en segundo plano. Patrón oficial de TanStack para RN.
 *
 * Se monta UNA sola vez en la raíz (`App.tsx`). Devuelve la función de limpieza del listener.
 */
function onAppStateChange(status: AppStateStatus): void {
  if (Platform.OS !== 'web') {
    focusManager.setFocused(status === 'active');
  }
}

export function wireReactQueryFocus(): () => void {
  const subscription = AppState.addEventListener('change', onAppStateChange);
  return () => subscription.remove();
}
