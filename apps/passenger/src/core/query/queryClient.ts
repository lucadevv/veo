import { ApiError } from '@veo/api-client';
import { focusManager, QueryClient } from '@tanstack/react-query';
import { AppState, type AppStateStatus } from 'react-native';

/**
 * Cablea el `focusManager` de React Query al `AppState` de React Native. En RN no existe el evento
 * `focus`/`visibilitychange` del DOM, así que sin esto el `refetchOnWindowFocus` (y la re-evaluación
 * del `refetchInterval` de los polls) NO se dispara al volver de background. Lo conectamos UNA vez al
 * cargar el módulo (efecto de import idempotente): cuando la app vuelve a `active`, marcamos focused →
 * las queries activas (p.ej. el poll del recibo en el cierre post-viaje) re-evalúan al instante.
 * Patrón canónico de @tanstack/react-query + react-native.
 */
focusManager.setEventListener((handleFocus) => {
  const onChange = (state: AppStateStatus): void => {
    handleFocus(state === 'active');
  };
  const subscription = AppState.addEventListener('change', onChange);
  return () => subscription.remove();
});

/**
 * Cliente de React Query (estado de servidor). El estado de cliente (sesión, UI) vive en Zustand.
 *
 * No reintentamos errores de cliente (4xx no retryables): sólo red/5xx/429, que el `HttpClient`
 * ya reintenta a bajo nivel. Aquí limitamos los reintentos de la capa de queries para no duplicar.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && !error.retryable) {
          return false;
        }
        return failureCount < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },
});
