import React from 'react';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {driverTheme} from '@veo/ui-kit';
import type {RegistrationStackParamList} from './types';
import {
  DocumentsScreen,
  IdentityVerificationScreen,
  PersonalDataScreen,
  RealFaceCaptureProvider,
  useRegistrationStore,
  VehicleScreen,
} from '../features/registration/presentation';

const Stack = createNativeStackNavigator<RegistrationStackParamList>();

/** Pantalla del wizard que corresponde a cada paso (1..4) del store. */
const STEP_ROUTES: Record<number, keyof RegistrationStackParamList> = {
  1: 'PersonalData',
  2: 'Vehicle',
  3: 'Documents',
  4: 'IdentityVerification',
};

/**
 * Resuelve la pantalla inicial del wizard a partir del avance persistido (`currentStep`). Así el
 * conductor REANUDA donde quedó (p. ej. cierra la app en Documentos y vuelve a Documentos) en vez de
 * arrancar siempre en `PersonalData`. Para `rejected`, enrutamos también al paso donde quedó su
 * avance (tiene datos previos que debe corregir); si no hay paso válido, caemos a `PersonalData`.
 */
function resolveInitialRoute(
  currentStep: number,
): keyof RegistrationStackParamList {
  return STEP_ROUTES[currentStep] ?? 'PersonalData';
}

/**
 * Wizard de registro: 4 pasos presentados con slide horizontal (`slide_from_right`). El estado del
 * alta vive en el store del feature; la captura facial REAL (cámara frontal nativa) se inyecta vía
 * `RealFaceCaptureProvider` (puerto propio del registro, independiente de la captura del turno).
 *
 * `initialRouteName` se deriva del `currentStep` del store en el primer render (no es reactivo a
 * propósito: solo fija dónde ABRE el stack; la navegación posterior la maneja cada pantalla). Los
 * pasos previos quedan en la pila, de modo que el back gesture/botón retrocede al paso anterior.
 */
export const RegistrationNavigator = (): React.JSX.Element => {
  // `getState()` (no selector reactivo): `initialRouteName` solo se lee al montar el navigator.
  const initialRouteName = resolveInitialRoute(useRegistrationStore.getState().currentStep);
  return (
    <RealFaceCaptureProvider>
      <Stack.Navigator
        initialRouteName={initialRouteName}
        screenOptions={{
          headerShown: false,
          animation: 'slide_from_right',
          contentStyle: {backgroundColor: driverTheme.colors.bg},
        }}>
        <Stack.Screen name="PersonalData" component={PersonalDataScreen} />
        <Stack.Screen name="Vehicle" component={VehicleScreen} />
        <Stack.Screen name="Documents" component={DocumentsScreen} />
        <Stack.Screen name="IdentityVerification" component={IdentityVerificationScreen} />
      </Stack.Navigator>
    </RealFaceCaptureProvider>
  );
};
