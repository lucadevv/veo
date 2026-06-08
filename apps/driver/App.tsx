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
import {DiProvider} from './src/core/di/useDi';
import {useSessionStore} from './src/core/session/sessionStore';
import {RealBiometricCaptureProvider} from './src/features/shift/presentation';
import {LocationSourceProvider} from './src/features/realtime/presentation';
import {backgroundGeolocationSource} from './src/features/realtime/data';
import {TripMediaPublisherProvider} from './src/features/trips/presentation';
import './src/i18n';

/**
 * Raíz de la app conductor. El árbol se envuelve con el `ThemeProvider` de `@veo/ui-kit` usando
 * `driverTheme` (modo noche, regla #6 de CLAUDE.md): el sistema de diseño es la única fuente de
 * estilos. El `ThemeProvider` se monta entre `SafeAreaProvider` y `QueryClientProvider`.
 */
const App = (): React.JSX.Element => {
  // Rehidrata la sesión (tokens persistidos en MMKV) antes de resolver el flujo protegido.
  useEffect(() => {
    useSessionStore.getState().hydrate();
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <ThemeProvider theme={driverTheme}>
          <QueryClientProvider client={queryClient}>
            <DiProvider>
              {/* Puertos nativos reales (oleada nativa): GPS, captura biométrica y publisher WebRTC. */}
              <RealBiometricCaptureProvider>
                <LocationSourceProvider source={backgroundGeolocationSource}>
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
