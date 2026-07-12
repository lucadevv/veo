import {
  DefaultTheme,
  NavigationContainer,
  type Theme,
} from '@react-navigation/native';
import {QueryClientProvider} from '@tanstack/react-query';
import {ThemeProvider, useTheme} from '@veo/ui-kit';
import React, {useEffect} from 'react';
import {AppState, type AppStateStatus} from 'react-native';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {container, TOKENS} from './core/di';
import {HttpSavedPlacesRepository} from './features/places/data/httpPlacesRepository';
import {useSavedPlacesStore} from './features/places/presentation';
import {queryClient} from './core/query/queryClient';
import {initSecureStorage} from './core/storage/mmkv';
import {useSessionStore} from './core/session/sessionStore';
// Inicializa i18n (es-PE) por efecto secundario antes de renderizar.
import './i18n';
import {RootNavigator} from './navigation/RootNavigator';
import {navigationRef} from './navigation/navigationRef';
import {flushPendingDeepLink} from './services/messaging';

// Puente de debug SÓLO en __DEV__ (no existe en release): expone el store de sesión y el nav ref para
// controlar la app desde herramientas externas (metro-mcp), p.ej. saltar de estado de auth durante la
// verificación de UI: `global.__veo.session.getState().clearSession()`.
if (__DEV__) {
  (globalThis as {__veo?: unknown}).__veo = {
    session: useSessionStore,
    nav: navigationRef,
  };
}

/**
 * Raíz de la app pasajero. Orden de providers:
 *  GestureHandler → SafeArea → ThemeProvider(passenger) → QueryClient → NavigationContainer.
 *
 * `ThemeProvider name="passenger"` aplica el tema cálido/claro de `@veo/ui-kit`.
 */
export default function App(): React.JSX.Element {
  const hydrate = useSessionStore(state => state.hydrate);

  // Inicializa el almacén seguro (crea la instancia MMKV con la clave del Keychain) y RECIÉN AHÍ
  // hidrata la sesión: leer los tokens antes de que el almacén exista con su clave real perdería la
  // sesión en cold-start (el bug del re-login forzado). La sesión está en estado `unknown` (splash)
  // hasta que `hydrate()` corre, así que el árbol no lee `secureStore` antes de tiempo.
  useEffect(() => {
    void initSecureStorage()
      .then(hydrate)
      // Tras hidratar la sesión, drená la cola durable de consentimiento (Ley 29733): si quedó una
      // aceptación encolada (onboarding sin red / cerrado antes de confirmar), este flush la entrega.
      // No bloquea el arranque ni lanza (el use case maneja el error y deja Pending si toca).
      .then(() => {
        void container.resolve(TOKENS.syncPendingConsentUseCase).flush();
      });
  }, [hydrate]);

  // Reintenta la cola de consentimiento cada vez que la app vuelve a primer plano: cubre el caso de
  // recuperar la red estando la app abierta (no había listener global de AppState; se agrega acá con
  // su cleanup). El flag `inFlight` del use case evita solaparse con el flush de boot/login.
  useEffect(() => {
    const onChange = (next: AppStateStatus): void => {
      if (next === 'active') {
        void container.resolve(TOKENS.syncPendingConsentUseCase).flush();
      }
    };
    const subscription = AppState.addEventListener('change', onChange);
    return () => subscription.remove();
  }, []);

  // Cablea el refresco del store de Lugares guardados cuando el repo HTTP reconcilia el caché con el
  // servidor (GET de fondo / write-through). Se hace acá, en el bootstrap, para no acoplar la
  // composición (registry) con la capa de presentación ni crear un ciclo registry↔store.
  useEffect(() => {
    const repo = container.resolve(TOKENS.placesRepository);
    if (repo instanceof HttpSavedPlacesRepository) {
      repo.setReconcileHooks({
        onCacheUpdated: () => useSavedPlacesStore.getState().refresh(),
        // Hidratación fallida SIN caché que mostrar: la pantalla pinta ERROR + reintento en vez de un
        // falso vacío (el repo solo emite este hook cuando no hay nada cacheado: degradación honesta).
        onLoadError: () =>
          useSavedPlacesStore.setState({loading: false, loadError: true}),
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
 * NavigationContainer con tema CLARO derivado del `@veo/ui-kit` (Theme de Confianza). Deriva de
 * `DefaultTheme` (base light de React Navigation) y sobreescribe los colores con los tokens reales,
 * así fondos/headers nativos matchean el lienzo claro. Vive dentro del ThemeProvider para leer los
 * tokens con `useTheme`.
 */
function ThemedNavigation(): React.JSX.Element {
  const theme = useTheme();
  const navTheme: Theme = {
    ...DefaultTheme,
    colors: {
      ...DefaultTheme.colors,
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
      onStateChange={flushPendingDeepLink}>
      <RootNavigator />
    </NavigationContainer>
  );
}

const styles = {root: {flex: 1}} as const;
