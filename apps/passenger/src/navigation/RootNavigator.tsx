import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTheme } from '@veo/ui-kit';
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  AuthScreen,
  BiometricLockScreen,
  CompleteProfileScreen,
  OnboardingScreen,
  SessionExpiredScreen,
  SplashScreen,
  useBiometricGateStore,
  useOnboardingStore,
} from '../features/auth/presentation';
import { useProfileCompletion } from '../features/profile/presentation';
import { TrustedContactsScreen } from '../features/contacts/presentation';
import { ChildModeScreen } from '../features/childMode/presentation';
import { KycCameraScreen } from '../features/kyc/presentation';
import { NotificationsScreen } from '../features/notifications/presentation';
import { PanicScreen } from '../features/panic/presentation';
import { PaymentMethodsScreen, PaymentScreen } from '../features/payments/presentation';
import { SavedPlacesScreen } from '../features/places/presentation';
import { ProfileScreen } from '../features/profile/presentation';
import { RatingScreen } from '../features/ratings/presentation';
import { ReferralsScreen } from '../features/referrals/presentation';
import { ChatScreen } from '../features/chat/presentation';
import { HelpScreen } from '../features/support/presentation';
import {
  CameraControlScreen,
  CameraLiveScreen,
  CounterScreen,
  LostItemScreen,
  NoOffersScreen,
  OffersBoardScreen,
  ReassignScreen,
  RequestFlowScreen,
  ScheduledTripsScreen,
  ScheduleNewScreen,
  TripActiveScreen,
  TripHistoryScreen,
} from '../features/trip/presentation';
import { RouteQuoteScreen, SearchScreen } from '../features/maps/presentation';
import { useSessionStore } from '../core/session/sessionStore';
import { initMessaging } from '../services/messaging';
import { IconTabHome, IconTabTrips, IconTabUser } from './components/TabBarIcons';
import { SplashGate } from './components/SplashGate';
import type { MainTabParamList, RootStackParamList } from './types';

/**
 * Navegador raíz del pasajero. Conmuta de stack según el estado de sesión (no navega
 * imperativamente): `unknown` → Splash, `unauthenticated` → Onboarding/Auth, `authenticated` →
 * tabs + pantallas de viaje/seguridad/pago.
 */

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();

function MainTabs(): React.JSX.Element {
  const theme = useTheme();
  const { t } = useTranslation();

  return (
    // `detachInactiveScreens` DESMONTA los tabs inactivos (vs. solo ocultarlos). El tab Home monta
    // el `MapView` de MapLibre, que asigna un contexto GL/Metal nativo. MapLibre 10.4.2 NO expone
    // teardown desde JS: el contexto solo se libera en el `deinit` nativo de la vista, y eso solo
    // ocurre cuando el componente se DESMONTA. Con `false`, el Home (y su mapa) quedaba montado
    // siempre; cada hot/fresh-reload dejaba un contexto GL huérfano → tras N reloads → mapa negro.
    // Con `true`, salir del tab desmonta el Home → MapLibre libera el contexto → el leak se corta.
    // Reentrar al Home remonta a su estado idle/peek (el natural); el borrador del viaje vive en
    // Zustand y sobrevive al desmonte, así que no se pierde nada del flujo.
    <Tab.Navigator
      detachInactiveScreens={true}
      screenOptions={{
        headerShown: false,
        // Congela los tabs inactivos que SÍ siguen montados durante la transición de detach, para
        // que no rendericen ni corran timers de fondo mientras se desmontan.
        freezeOnBlur: true,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.inkSubtle,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
        },
      }}
    >
      <Tab.Screen
        name="Home"
        component={RequestFlowScreen}
        options={{
          title: t('screens.home'),
          tabBarIcon: ({ focused, color }) => <IconTabHome active={focused} color={color} />,
        }}
      />
      <Tab.Screen
        name="TripHistory"
        component={TripHistoryScreen}
        options={{
          title: t('screens.tripHistory'),
          tabBarIcon: ({ focused, color }) => <IconTabTrips active={focused} color={color} />,
        }}
      />
      <Tab.Screen
        name="Profile"
        component={ProfileScreen}
        options={{
          title: t('screens.profile'),
          tabBarIcon: ({ focused, color }) => <IconTabUser active={focused} color={color} />,
        }}
      />
    </Tab.Navigator>
  );
}

export function RootNavigator(): React.JSX.Element {
  const { t } = useTranslation();
  const theme = useTheme();
  const status = useSessionStore((state) => state.status);
  const onboardingCompleted = useOnboardingStore((state) => state.completed);
  const biometricLocked = useBiometricGateStore((state) => state.locked);
  // Completitud derivada del perfil REAL (`GET /users/me`) o de la bandera local por usuario; no
  // de un flag global (que atrapaba a sesiones existentes). 'loading' mientras se resuelve.
  const profileCompletion = useProfileCompletion();

  // Registro de push (FCM/APNs) una vez que la sesión está activa y desbloqueada. Cubre tanto el
  // login fresco como el cold-start con sesión rehidratada. Best-effort y gateado por
  // FIREBASE_ENABLED dentro de initMessaging; no bloquea ni tumba la navegación.
  const pushRegistered = React.useRef(false);
  React.useEffect(() => {
    const active = status === 'authenticated' && !biometricLocked;
    if (active && !pushRegistered.current) {
      pushRegistered.current = true;
      void initMessaging();
    } else if (!active) {
      // Sesión cerrada/bloqueada: permite re-registrar en el próximo login.
      pushRegistered.current = false;
    }
  }, [status, biometricLocked]);

  // Splash de MARCA del cold-start: se muestra con un PISO de duración (~1.9s) aunque la sesión
  // rehidrate al instante (MMKV), así no flashea y se aprecia la marca. `splashDone` mantiene el
  // splash montado hasta que (sesión resuelta) AND (piso cumplido); el `SplashGate` hace el
  // fade-out con gusto y recién ahí lo da por terminado, revelando el stack real. Es un piso, no un
  // techo: si la sesión tarda, `ready` llega tarde y el splash sigue (lo correcto en errores/red).
  const [splashDone, setSplashDone] = React.useState(false);
  const handleSplashDone = React.useCallback(() => setSplashDone(true), []);

  if (!splashDone) {
    return (
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Splash">
          {() => <SplashGate ready={status !== 'unknown'} onDone={handleSplashDone} />}
        </Stack.Screen>
      </Stack.Navigator>
    );
  }

  // Flujo de entrada (no autenticado) en UN solo navegador con transición `fade`: al revelarse tras
  // el splash, la sesión ya está resuelta (`splashDone` solo es `true` con `status !== 'unknown'`),
  // así que solo resta conmutar Onboarding/Auth. El fondo oscuro compartido evita destellos.
  if (status !== 'authenticated') {
    return (
      <Stack.Navigator screenOptions={{ headerShown: false, animation: 'fade' }}>
        {onboardingCompleted ? (
          <Stack.Screen name="Auth" component={AuthScreen} />
        ) : (
          <Stack.Screen name="Onboarding" component={OnboardingScreen} />
        )}
      </Stack.Navigator>
    );
  }

  // Autenticado pero con candado biométrico activo (sesión rehidratada en frío): re-login local.
  if (biometricLocked) {
    return (
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="BiometricLock" component={BiometricLockScreen} />
      </Stack.Navigator>
    );
  }

  // Autenticado y desbloqueado, resolviendo la completitud del perfil (`GET /users/me`): Splash
  // como pantalla de espera para no destellar "Completar perfil" a sesiones ya completas.
  if (profileCompletion === 'loading') {
    return (
      <Stack.Navigator screenOptions={{ headerShown: false, animation: 'fade' }}>
        <Stack.Screen name="Splash" component={SplashScreen} />
      </Stack.Navigator>
    );
  }

  // Autenticado y desbloqueado pero con el perfil incompleto (sin email real ni bandera local):
  // completar perfil antes de entrar. Conmutación por estado derivado, no navegación imperativa.
  if (profileCompletion === 'incomplete') {
    return (
      <Stack.Navigator screenOptions={{ headerShown: false, animation: 'fade' }}>
        <Stack.Screen name="CompleteProfile" component={CompleteProfileScreen} />
      </Stack.Navigator>
    );
  }

  // Autenticado: app principal. Header y fondo con el tema oscuro (Midnight Motion): sin esto
  // el header nativo sale BLANCO y rompe el diseño en las pantallas con `headerShown: true`.
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: true,
        headerStyle: { backgroundColor: theme.colors.bg },
        headerTintColor: theme.colors.ink,
        headerTitleStyle: { color: theme.colors.ink },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: theme.colors.bg },
      }}
    >
      <Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
      <Stack.Screen
        name="Search"
        component={SearchScreen}
        options={{ headerShown: false, animation: 'slide_from_right' }}
      />
      <Stack.Screen
        name="RouteQuote"
        component={RouteQuoteScreen}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="OffersBoard"
        component={OffersBoardScreen}
        options={{ title: t('screens.offersBoard') }}
      />
      <Stack.Screen
        name="Counter"
        component={CounterScreen}
        options={{ title: t('screens.counter') }}
      />
      <Stack.Screen
        name="NoOffers"
        component={NoOffersScreen}
        options={{ title: t('screens.noOffers') }}
      />
      <Stack.Screen
        name="TripActive"
        component={TripActiveScreen}
        options={{ title: t('screens.tripActive') }}
      />
      {/* Control de cámara: header oscuro estándar, igual que el diseño CameraControl. */}
      <Stack.Screen
        name="CameraControl"
        component={CameraControlScreen}
        options={{ title: t('screens.cameraControl') }}
      />
      <Stack.Screen
        name="ScheduledTrips"
        component={ScheduledTripsScreen}
        options={{ title: t('screens.scheduledTrips') }}
      />
      <Stack.Screen
        name="ScheduleNew"
        component={ScheduleNewScreen}
        options={{ title: t('screens.scheduleNew') }}
      />
      <Stack.Screen
        name="Notifications"
        component={NotificationsScreen}
        options={{ title: t('screens.notifications') }}
      />
      <Stack.Screen
        name="LostItem"
        component={LostItemScreen}
        options={{ title: t('screens.lostItem') }}
      />
      {/* Reasignación (REASSIGNING): inmersiva, sin header del SO, sin gesto de retroceso —
          el flujo continúa al board de ofertas o cancela explícitamente. */}
      <Stack.Screen
        name="Reassign"
        component={ReassignScreen}
        options={{ headerShown: false, gestureEnabled: false }}
      />
      <Stack.Screen
        name="TrustedContacts"
        component={TrustedContactsScreen}
        options={{ title: t('screens.trustedContacts') }}
      />
      <Stack.Screen name="ChildMode" component={ChildModeScreen} options={{ title: t('screens.childMode') }} />
      <Stack.Screen
        name="KycCamera"
        component={KycCameraScreen}
        options={{ title: t('screens.kycCamera'), headerShown: false, animation: 'slide_from_bottom' }}
      />
      <Stack.Screen
        name="PaymentMethods"
        component={PaymentMethodsScreen}
        options={{ title: t('screens.paymentMethods') }}
      />
      <Stack.Screen name="Payment" component={PaymentScreen} options={{ title: t('screens.payment') }} />
      <Stack.Screen name="Rating" component={RatingScreen} options={{ title: t('screens.rating') }} />
      <Stack.Screen
        name="SavedPlaces"
        component={SavedPlacesScreen}
        options={{ title: t('screens.savedPlaces') }}
      />
      <Stack.Screen
        name="Referrals"
        component={ReferralsScreen}
        options={{ title: t('screens.referrals') }}
      />
      <Stack.Screen
        name="Chat"
        component={ChatScreen}
        options={{ title: t('screens.chat'), animation: 'slide_from_bottom' }}
      />
      <Stack.Screen name="Help" component={HelpScreen} options={{ title: t('screens.help') }} />
      <Stack.Group screenOptions={{ presentation: 'fullScreenModal', headerShown: false }}>
        {/* Cámara del viaje a pantalla completa (Ola 2A): modal full-screen, sin chrome del SO. */}
        <Stack.Screen name="CameraLive" component={CameraLiveScreen} />
        <Stack.Screen name="Panic" component={PanicScreen} />
        {/* Sesión expirada por inactividad: la pantalla y la ruta existen; el trigger que conmuta
            a este estado queda como follow-up. */}
        <Stack.Screen name="SessionExpired" component={SessionExpiredScreen} />
      </Stack.Group>
    </Stack.Navigator>
  );
}
