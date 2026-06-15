import { DarkTheme, NavigationContainer, type Theme } from '@react-navigation/native';
import { QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, useTheme } from '@veo/ui-kit';
import React, { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { container, TOKENS } from './core/di';
import { HttpSavedPlacesRepository } from './features/places/data/httpPlacesRepository';
import { useSavedPlacesStore } from './features/places/presentation';
import { queryClient } from './core/query/queryClient';
import { initSecureStorage } from './core/storage/mmkv';
import { useSessionStore } from './core/session/sessionStore';
// Inicializa i18n (es-PE) por efecto secundario antes de renderizar.
import './i18n';
import { RootNavigator } from './navigation/RootNavigator';
import { navigationRef } from './navigation/navigationRef';
import { flushPendingDeepLink } from './services/messaging';

/**
 * Raíz de la app pasajero. Orden de providers:
 *  GestureHandler → SafeArea → ThemeProvider(passenger) → QueryClient → NavigationContainer.
 *
 * `ThemeProvider name="passenger"` aplica el tema cálido/claro de `@veo/ui-kit`.
 */
export default function App(): React.JSX.Element {
  const hydrate = useSessionStore((state) => state.hydrate);

  // Inicializa el almacén seguro (crea la instancia MMKV con la clave del Keychain) y RECIÉN AHÍ
  // hidrata la sesión: leer los tokens antes de que el almacén exista con su clave real perdería la
  // sesión en cold-start (el bug del re-login forzado). La sesión está en estado `unknown` (splash)
  // hasta que `hydrate()` corre, así que el árbol no lee `secureStore` antes de tiempo.
  useEffect(() => {
    void initSecureStorage().then(hydrate);
  }, [hydrate]);

  // Cablea el refresco del store de Lugares guardados cuando el repo HTTP reconcilia el caché con el
  // servidor (GET de fondo / write-through). Se hace acá, en el bootstrap, para no acoplar la
  // composición (registry) con la capa de presentación ni crear un ciclo registry↔store.
  useEffect(() => {
    const repo = container.resolve(TOKENS.placesRepository);
    if (repo instanceof HttpSavedPlacesRepository) {
      repo.setReconcileHooks({
        onCacheUpdated: () => useSavedPlacesStore.getState().refresh(),
      });
      // Primera hidratación desde el servidor al arrancar (boot-real): la lista refleja el backend.
      useSavedPlacesStore.getState().refresh();
    }
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <ThemeProvider name="passenger">
          <QueryClientProvider client={queryClient}>
            <ThemedNavigation />
          </QueryClientProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/**
 * NavigationContainer con tema OSCURO derivado del `@veo/ui-kit` (Midnight Motion). Sin esto, React
 * Navigation usa su tema claro por defecto → fondos y headers BLANCOS que rompen el diseño oscuro en
 * varias pantallas. Vive dentro del ThemeProvider para leer los tokens reales con `useTheme`.
 */
function ThemedNavigation(): React.JSX.Element {
  const theme = useTheme();
  const navTheme: Theme = {
    ...DarkTheme,
    colors: {
      ...DarkTheme.colors,
      background: theme.colors.bg,
      card: theme.colors.bg,
      text: theme.colors.ink,
      border: theme.colors.border,
      primary: theme.colors.accent,
      notification: theme.colors.danger,
    },
  };
  return (
    <NavigationContainer
      ref={navigationRef}
      theme={navTheme}
      onReady={flushPendingDeepLink}
      // Reintenta el deep-link pendiente en cada conmutación de stack: cuando la sesión pasa de
      // bloqueada/no-autenticada a autenticada, recién ahí monta OffersBoard y la navegación aterriza.
      onStateChange={flushPendingDeepLink}
    >
      <RootNavigator />
    </NavigationContainer>
  );
}

const styles = { root: { flex: 1 } } as const;
