import React from 'react';
import { StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { driverTheme, useTheme } from '@veo/ui-kit';
import type { MainTabParamList, RootStackParamList } from './types';
import { useSessionStore } from '../core/session/sessionStore';
import {
  LoginScreen,
  OnboardingScreen,
  SplashScreen,
  useOnboardingStore,
} from '../features/auth/presentation';
import {
  RegistrationGateRetryScreen,
  RejectedScreen,
  UnderReviewScreen,
  VehiclesScreen,
  useRegistrationGate,
  useRegistrationStore,
} from '../features/registration/presentation';
import { RegistrationNavigator } from './RegistrationNavigator';
import {
  BiometricEnrollScreen,
  DashboardScreen,
  ShiftStartScreen,
  ShiftSummaryScreen,
} from '../features/shift/presentation';
import {
  TripActiveScreen,
  TripCompleteScreen,
  TripDetailScreen,
  TripHistoryScreen,
  TripIncomingScreen,
} from '../features/trips/presentation';
import { BidsScreen } from '../features/bidding/presentation';
import { EarningsScreen } from '../features/earnings/presentation';
import { ProfileScreen } from '../features/profile/presentation';
import { DocumentsScreen } from '../features/documents/presentation';
import { IncentivesScreen } from '../features/ops/presentation';
import { SupportScreen } from '../features/support/presentation';
import { ChatScreen } from '../features/chat/presentation';
import {
  CarpoolPublishScreen,
  CarpoolScreen,
  CarpoolTripBookingsScreen,
} from '../features/carpool/presentation';
import { RealtimeManager } from '../features/realtime/presentation';
import { NotificationsScreen, PushManager } from '../features/notifications/presentation';
import {
  IconAccount,
  IconCarpool,
  IconEarnings,
  IconMap,
  IconTrips,
} from '../shared/presentation/icons';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();

const screenOptions = {
  headerShown: false,
  contentStyle: { backgroundColor: driverTheme.colors.bg },
} as const;

/**
 * Tab bar principal del conductor ("Midnight Motion"): 4 secciones con íconos propios.
 * El acento activo es el cian del `driverTheme`; el inactivo, `inkSubtle`. Fondo `surface`.
 */
function MainTabs(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();
  // El home-indicator (iPhone) y la barra de gestos (Android) viven en `insets.bottom`. Un `height`
  // fijo en `tabBarStyle` PISA el inset que React Navigation añade solo, dejando el tab bar pegado al
  // borde. Sumamos el inset al alto y al padding inferior: mantenemos el look compacto de 64px de
  // CONTENIDO y reservamos la zona segura debajo (igual criterio que el footer de `SafeScreen`).
  const insets = useSafeAreaInsets();
  return (
    <Tab.Navigator
      detachInactiveScreens={false}
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.inkSubtle,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
          borderTopWidth: StyleSheet.hairlineWidth,
          height: 64 + insets.bottom,
          paddingTop: 8,
          paddingBottom: 10 + insets.bottom,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        tabBarIcon: ({ color, focused }) => {
          const size = 24;
          const sw = focused ? 2.4 : 2;
          switch (route.name) {
            case 'Inicio':
              return <IconMap size={size} color={color} strokeWidth={sw} />;
            case 'Compartir':
              return <IconCarpool size={size} color={color} strokeWidth={sw} />;
            case 'Ganancias':
              return <IconEarnings size={size} color={color} strokeWidth={sw} />;
            case 'Viajes':
              return <IconTrips size={size} color={color} strokeWidth={sw} />;
            case 'Cuenta':
              return <IconAccount size={size} color={color} strokeWidth={sw} />;
            default:
              return null;
          }
        },
      })}
    >
      {/* `name` es el ID de ruta (no se traduce, lo usa la navegación); la etiqueta visible va por
          `tabBarLabel` i18n. Antes el `name` se renderizaba como label → texto hardcodeado en el tab bar. */}
      <Tab.Screen
        name="Inicio"
        component={DashboardScreen}
        options={{ tabBarLabel: t('nav.home') }}
      />
      <Tab.Screen
        name="Compartir"
        component={CarpoolScreen}
        options={{ tabBarLabel: t('nav.carpool') }}
      />
      <Tab.Screen
        name="Ganancias"
        component={EarningsScreen}
        options={{ tabBarLabel: t('nav.earnings') }}
      />
      <Tab.Screen
        name="Viajes"
        component={TripHistoryScreen}
        options={{ tabBarLabel: t('nav.trips') }}
      />
      <Tab.Screen
        name="Cuenta"
        component={ProfileScreen}
        options={{ tabBarLabel: t('nav.account') }}
      />
    </Tab.Navigator>
  );
}

/**
 * Stack raíz con guarda de sesión + estado de alta:
 *  - `bootstrapping`: splash animado mientras rehidrata tokens.
 *  - `unauthenticated`: onboarding (si no se ha visto) → login/re-login (OTP).
 *  - `authenticated` + resolviendo alta: splash mientras `GET /drivers/me` confirma el estado
 *    (evita mandar al wizard por defecto y los parpadeos).
 *  - `authenticated` + alta NO aprobada: wizard de registro / pantalla "En revisión".
 *  - `authenticated` + alta aprobada: tabs operativas + pantallas full-screen + realtime montado.
 *
 * El estado del alta (`registrationStatus`) se rehidrata desde el perfil del conductor vía
 * `useRegistrationGate` y conmuta aquí por estado (no imperativa). El override local solo actúa como
 * fallback de demo si la llamada falla y nunca se resolvió antes (ver `useRegistrationGate`).
 */
export const RootNavigator = (): React.JSX.Element => {
  const status = useSessionStore((s) => s.status);
  const onboardingCompleted = useOnboardingStore((s) => s.completed);
  const registrationStatus = useRegistrationStore((s) => s.status);
  // Resuelve el estado del alta desde el backend tras autenticar (no parpadea hacia el wizard).
  const { resolving, needsRetry, retry } = useRegistrationGate();

  if (status === 'bootstrapping') {
    return <SplashScreen />;
  }

  if (status === 'unauthenticated') {
    return (
      <Stack.Navigator screenOptions={{ ...screenOptions, animation: 'fade' }}>
        {onboardingCompleted ? (
          <Stack.Screen name="Login" component={LoginScreen} />
        ) : (
          <Stack.Screen name="Onboarding" component={OnboardingScreen} />
        )}
      </Stack.Navigator>
    );
  }

  // Conductor autenticado: mientras el backend confirma el estado del alta por primera vez, se
  // mantiene el splash para no enviar al wizard por defecto ni parpadear.
  if (resolving) {
    return <SplashScreen />;
  }

  // El backend no respondió `GET /drivers/me` (error NO definitivo: red / 5xx) y nunca resolvió
  // antes: pantalla de reintento. NO limpiamos la sesión (tokens válidos) ni mostramos un error de
  // login confuso; ofrecemos recuperar el flujo con un reintento explícito. El 404 no llega acá
  // (ese fuerza el wizard arriba, en el gate).
  if (needsRetry) {
    return (
      <Stack.Navigator screenOptions={{ ...screenOptions, animation: 'fade' }}>
        <Stack.Screen name="RegistrationGateRetry">
          {() => <RegistrationGateRetryScreen onRetry={retry} />}
        </Stack.Screen>
      </Stack.Navigator>
    );
  }

  // Conductor autenticado pero con el alta sin aprobar: wizard, revisión o rechazo.
  // En `in_review` y `rejected` el conductor YA está autenticado (userId/token válidos): montamos el
  // `PushManager` igual que en la rama aprobada para que el push de aprobación/rechazo invalide el gate
  // al instante y la pantalla conmute SIN esperar el sondeo de 60s. No se monta en `resolving`/
  // `needsRetry`/`unauthenticated` (sesión aún no resuelta / no hay sesión).
  if (registrationStatus === 'in_review') {
    return (
      <>
        <Stack.Navigator screenOptions={{ ...screenOptions, animation: 'fade' }}>
          <Stack.Screen name="UnderReview" component={UnderReviewScreen} />
        </Stack.Navigator>
        <PushManager />
      </>
    );
  }

  // Alta RECHAZADA: pantalla propia con el motivo + corregir-y-reenviar (NO cae al wizard mudo).
  if (registrationStatus === 'rejected') {
    return (
      <>
        <Stack.Navigator screenOptions={{ ...screenOptions, animation: 'fade' }}>
          <Stack.Screen name="Rejected" component={RejectedScreen} />
        </Stack.Navigator>
        <PushManager />
      </>
    );
  }

  if (registrationStatus === 'not_started' || registrationStatus === 'in_progress') {
    return (
      <Stack.Navigator screenOptions={{ ...screenOptions, animation: 'fade' }}>
        <Stack.Screen name="Registration" component={RegistrationNavigator} />
      </Stack.Navigator>
    );
  }

  return (
    <>
      <Stack.Navigator initialRouteName="Main" screenOptions={screenOptions}>
        <Stack.Screen name="Main" component={MainTabs} />
        <Stack.Screen name="ShiftStart" component={ShiftStartScreen} />
        {/* Cierre de turno (resumen + ganancias del día). Terminal: sin gesto atrás — se sale con los CTA. */}
        <Stack.Screen
          name="ShiftSummary"
          component={ShiftSummaryScreen}
          options={{ gestureEnabled: false, animation: 'fade' }}
        />
        <Stack.Screen name="BiometricEnroll" component={BiometricEnrollScreen} />
        <Stack.Screen name="Documents" component={DocumentsScreen} />
        <Stack.Screen name="Vehicles" component={VehiclesScreen} />
        <Stack.Screen name="Incentives" component={IncentivesScreen} />
        <Stack.Screen
          name="Notifications"
          component={NotificationsScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen name="Support" component={SupportScreen} />
        <Stack.Screen
          name="TripIncoming"
          component={TripIncomingScreen}
          options={{ gestureEnabled: false, animation: 'fade' }}
        />
        <Stack.Screen
          name="TripActive"
          component={TripActiveScreen}
          options={{ gestureEnabled: false }}
        />
        {/* Cierre del viaje (resumen + rating). Terminal: sin gesto atrás — se sale con "Listo". */}
        <Stack.Screen
          name="TripComplete"
          component={TripCompleteScreen}
          options={{ gestureEnabled: false, animation: 'fade' }}
        />
        {/* Detalle/recibo de un viaje del historial (se llega desde la fila del historial). */}
        <Stack.Screen
          name="TripDetail"
          component={TripDetailScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen
          name="Bids"
          component={BidsScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen
          name="Chat"
          component={ChatScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen
          name="CarpoolPublish"
          component={CarpoolPublishScreen}
          options={{ animation: 'slide_from_right' }}
        />
        <Stack.Screen
          name="CarpoolTripBookings"
          component={CarpoolTripBookingsScreen}
          options={{ animation: 'slide_from_right' }}
        />
      </Stack.Navigator>
      <RealtimeManager />
      <PushManager />
    </>
  );
};
