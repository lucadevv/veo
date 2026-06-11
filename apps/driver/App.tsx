import React, {useEffect} from 'react';
import {StyleSheet} from 'react-native';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {NavigationContainer} from '@react-navigation/native';
import {QueryClientProvider} from '@tanstack/react-query';
import {ThemeProvider, driverTheme} from '@veo/ui-kit';
import {RootNavigator} from './src/navigation/RootNavigator';
import {navigationRef} from './src/navigation/navigationRef';
import {navigationTheme} from './src/theme';
import {queryClient} from './src/core/query/queryClient';
import {initSecureStorage} from './src/core/storage/mmkv';
import {wireReactQueryFocus} from './src/core/query/nativeAppState';
import {DiProvider} from './src/core/di/useDi';
import {useSessionStore} from './src/core/session/sessionStore';
import {RealBiometricCaptureProvider} from './src/features/shift/presentation';
import {LocationSourceProvider} from './src/features/realtime/presentation';
import {selectLocationSource} from './src/features/realtime/data';
import {TripMediaPublisherProvider} from './src/features/trips/presentation';
import './src/i18n';

/**
 * Raíz de la app conductor. El árbol se envuelve con el `ThemeProvider` de `@veo/ui-kit` usando
 * `driverTheme` (modo noche, regla #6 de CLAUDE.md): el sistema de diseño es la única fuente de
 * estilos. El `ThemeProvider` se monta entre `SafeAreaProvider` y `QueryClientProvider`.
 */
const App = (): React.JSX.Element => {
  // Rehidrata la sesión (tokens persistidos en MMKV cifrado) antes de resolver el flujo protegido.
  // CRÍTICO: el almacén seguro se re-cifra con la clave del Keychain de forma ASÍNCRONA (`recrypt`);
  // hidratar ANTES de que termine leería los tokens con la clave de ARRANQUE equivocada → null →
  // login espurio en cada cold-start (y, al leer el refreshToken como null, el refresh nunca dispara
  // → la sesión muere a los 15 min). Esperamos a que el cifrado esté listo y recién ahí rehidratamos.
  // `initSecureStorage` está memoizada: comparte la promesa que `index.js` ya disparó (no re-cifra).
  useEffect(() => {
    void initSecureStorage().finally(() => useSessionStore.getState().hydrate());
  }, []);

  // Puente React Query ↔ AppState: revalida queries con `refetchOnWindowFocus` al volver a primer plano
  // (RN no tiene foco de ventana). Clave para el estado de turno (un suspendido no debe seguir operando).
  useEffect(() => wireReactQueryFocus(), []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <ThemeProvider theme={driverTheme}>
          <QueryClientProvider client={queryClient}>
            <DiProvider>
              {/* Puertos nativos reales (oleada nativa): GPS, captura biométrica y publisher WebRTC.
                  GPS: `selectLocationSource()` usa la fuente nativa en release; SOLO en dev sin módulo
                  nativo enlazado (simulador) cae al stub que "maneja" una posición sintética. */}
              <RealBiometricCaptureProvider>
                <LocationSourceProvider source={selectLocationSource()}>
                  <TripMediaPublisherProvider>
                    <NavigationContainer ref={navigationRef} theme={navigationTheme}>
                      <RootNavigator />
                    </NavigationContainer>
                  </TripMediaPublisherProvider>
                </LocationSourceProvider>
              </RealBiometricCaptureProvider>
            </DiProvider>
          </QueryClientProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: driverTheme.colors.bg,
  },
});

export default App;
