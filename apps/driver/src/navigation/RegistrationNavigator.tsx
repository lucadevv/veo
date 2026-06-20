import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { driverTheme } from '@veo/ui-kit';
import type { RegistrationStackParamList } from './types';
import { resolveInitialRoute } from './registrationStackRoutes';
import {
  DocumentsScreen,
  IdentityVerificationScreen,
  PersonalDataScreen,
  RealFaceCaptureProvider,
  RealLivenessCaptureProvider,
  useRegistrationStore,
  VehicleScreen,
} from '../features/registration/presentation';

const Stack = createNativeStackNavigator<RegistrationStackParamList>();

/**
 * Wizard de registro: 4 pasos presentados con slide horizontal (`slide_from_right`). El estado del
 * alta vive en el store del feature; la captura de LIVENESS REAL (cámara frontal nativa) se inyecta vía
 * `RealLivenessCaptureProvider` (puerto propio del registro, independiente de la captura del turno). Se
 * conserva `RealFaceCaptureProvider` por compatibilidad con consumidores previos del puerto de foto.
 *
 * `initialRouteName` se deriva del `currentStep` del store (`resolveInitialRoute`) y fija el paso N
 * como pantalla SUPERIOR: el primer paint ya es la pantalla correcta al reanudar. En native-stack
 * `initialRouteName` monta UNA sola pantalla (NO apila los pasos previos); por eso, al REANUDAR en un
 * paso > 1 (MMKV persistido, o `RejectedScreen.onFix`→`setCurrentStep`), cada pantalla de paso 2/3/4
 * reconstruye su propia pila `[PersonalData … pasoN]` vía `useRegistrationStepBack`
 * (`CommonActions.reset`, una sola vez, sin flash porque el top no cambia). Así el back gesture/botón
 * retrocede por los pasos completados hasta el paso 1, donde toma el exit-guard de raíz (Lote 1). Sin
 * esa reconstrucción la pila quedaría `[pasoN]` y un `goBack` moriría con "GO_BACK was not handled".
 */
export const RegistrationNavigator = (): React.JSX.Element => {
  // `getState()` (no selector reactivo): `initialRouteName` solo se lee al montar el navigator.
  const initialRouteName = resolveInitialRoute(useRegistrationStore.getState().currentStep);
  return (
    <RealFaceCaptureProvider>
      <RealLivenessCaptureProvider>
        <Stack.Navigator
          initialRouteName={initialRouteName}
          screenOptions={{
            headerShown: false,
            animation: 'slide_from_right',
            contentStyle: { backgroundColor: driverTheme.colors.bg },
          }}
        >
          <Stack.Screen name="PersonalData" component={PersonalDataScreen} />
          <Stack.Screen name="Vehicle" component={VehicleScreen} />
          <Stack.Screen name="Documents" component={DocumentsScreen} />
          <Stack.Screen name="IdentityVerification" component={IdentityVerificationScreen} />
        </Stack.Navigator>
      </RealLivenessCaptureProvider>
    </RealFaceCaptureProvider>
  );
};
