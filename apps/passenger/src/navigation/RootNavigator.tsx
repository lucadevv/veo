import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {useTheme} from '@veo/ui-kit';
import React from 'react';
import {useTranslation} from 'react-i18next';
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
import {useProfileCompletion} from '../features/profile/presentation';
import {TrustedContactsScreen} from '../features/contacts/presentation';
import {ChildModeScreen} from '../features/childMode/presentation';
import {KycCameraScreen} from '../features/kyc/presentation';
import {
  NotificationPrefsScreen,
  NotificationsScreen,
} from '../features/notifications/presentation';
import {PanicScreen} from '../features/panic/presentation';
import {
  PaymentMethodsScreen,
  PaymentScreen,
} from '../features/payments/presentation';
import {SavedPlacesScreen} from '../features/places/presentation';
import {RatingScreen} from '../features/ratings/presentation';
import {ReferralsScreen} from '../features/referrals/presentation';
import {ChatScreen} from '../features/chat/presentation';
import {HelpScreen} from '../features/support/presentation';
import {
  CameraControlScreen,
  CameraLiveScreen,
  CounterScreen,
  FamilyShareScreen,
  LostItemScreen,
  NoOffersScreen,
  OffersBoardScreen,
  ReassignScreen,
  ScheduledTripsScreen,
  ScheduleNewScreen,
  TripActiveScreen,
} from '../features/trip/presentation';
import {
  CarpoolBookingReviewScreen,
  CarpoolBookingStatusScreen,
  CarpoolResultsScreen,
  CarpoolSearchScreen,
  CarpoolTripDetailScreen,
} from '../features/carpool/presentation';
import {
  MapPickScreen,
  RouteQuoteScreen,
  SearchScreen,
} from '../features/maps/presentation';
import {useSessionStore} from '../core/session/sessionStore';
import {syncPushRegistration} from '../services/messaging';
import {SplashGate} from './components/SplashGate';
import type {RootStackParamList} from './types';

/**
 * Navegador raíz del pasajero. Conmuta de stack según el estado de sesión (no navega
 * imperativamente): `unknown` → Splash, `unauthenticated` → Onboarding/Auth, `authenticated` →
 * Home (raíz) + pantallas de viaje/seguridad/pago.
 *
 * REFACTOR navegación (sin bottom tabs): se eliminó el `createBottomTabNavigator` de 3 tabs. `Home`
 * (`RequestFlowScreen`) es ahora la PRIMERA `Stack.Screen` del stack autenticado (initialRoute de
 * facto); `Profile` se alcanza por el avatar del header del Home y `TripHistory` ("Mis viajes") es
 * una entrada del Perfil. El teardown del contexto GL del mapa que antes hacía `detachInactiveScreens`
 * (desmontar el Home al cambiar de tab) ahora lo replica un guard de foco (`useIsFocused`) en
 * `RequestFlowScreen`, que desmonta el `AppMap` cuando el Home pierde foco (ver allí).
 */

import {MainTabs} from './MainTabs';

const Stack = createNativeStackNavigator<RootStackParamList>();

export function RootNavigator(): React.JSX.Element {
  const {t} = useTranslation();
  const theme = useTheme();
  const status = useSessionStore(state => state.status);
  const onboardingCompleted = useOnboardingStore(state => state.completed);
  const biometricLocked = useBiometricGateStore(state => state.locked);
  // Completitud derivada del perfil REAL (`GET /users/me`) o de la bandera local por usuario; no
  // de un flag global (que atrapaba a sesiones existentes). 'loading' mientras se resuelve.
  const profileCompletion = useProfileCompletion();

  // SINCRONIZACIÓN de push una vez que la sesión está activa y desbloqueada: registra el token SOLO si
  // el permiso YA estaba concedido (NO promptea — el permiso se pide PROGRESIVO: pre-prompt contextual
  // al pedir viaje + toggle del perfil). Cubre login fresco y cold-start. Best-effort, gateado por
  // FIREBASE_ENABLED; no bloquea ni tumba la navegación. Quien ya aceptó sigue recibiendo push.
  const pushRegistered = React.useRef(false);
  React.useEffect(() => {
    const active = status === 'authenticated' && !biometricLocked;
    if (active && !pushRegistered.current) {
      pushRegistered.current = true;
      void syncPushRegistration();
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
      <Stack.Navigator screenOptions={{headerShown: false}}>
        <Stack.Screen name="Splash">
          {() => (
            <SplashGate
              ready={status !== 'unknown'}
              onDone={handleSplashDone}
            />
          )}
        </Stack.Screen>
      </Stack.Navigator>
    );
  }

  // Sesión EXPIRADA (refresh JWT falló / venció): pantalla dedicada de re-login forzado. Es un
  // estado tipado de la máquina de auth, distinto de 'unauthenticated' (logout intencional / cold
  // start sin sesión). Va ANTES del branch de Onboarding/Auth para que 'expired' no caiga al flujo
  // de ingreso normal. Desde `SessionExpired` el usuario re-ingresa con motivo 'user-logout' →
  // 'unauthenticated' → Auth.
  if (status === 'expired') {
    return (
      <Stack.Navigator screenOptions={{headerShown: false, animation: 'fade'}}>
        <Stack.Screen name="SessionExpired" component={SessionExpiredScreen} />
      </Stack.Navigator>
    );
  }

  // Flujo de entrada (no autenticado) en UN solo navegador con transición `fade`: al revelarse tras
  // el splash, la sesión ya está resuelta (`splashDone` solo es `true` con `status !== 'unknown'`),
  // así que solo resta conmutar Onboarding/Auth. El fondo oscuro compartido evita destellos.
  if (status !== 'authenticated') {
    return (
      <Stack.Navigator screenOptions={{headerShown: false, animation: 'fade'}}>
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
      <Stack.Navigator screenOptions={{headerShown: false}}>
        <Stack.Screen name="BiometricLock" component={BiometricLockScreen} />
      </Stack.Navigator>
    );
  }

  // Autenticado y desbloqueado, resolviendo la completitud del perfil (`GET /users/me`): Splash
  // como pantalla de espera para no destellar "Completar perfil" a sesiones ya completas.
  if (profileCompletion === 'loading') {
    return (
      <Stack.Navigator screenOptions={{headerShown: false, animation: 'fade'}}>
        <Stack.Screen name="Splash" component={SplashScreen} />
      </Stack.Navigator>
    );
  }

  // Autenticado y desbloqueado pero con el perfil incompleto (sin email real ni bandera local):
  // completar perfil antes de entrar. Conmutación por estado derivado, no navegación imperativa.
  if (profileCompletion === 'incomplete') {
    return (
      <Stack.Navigator screenOptions={{headerShown: false, animation: 'fade'}}>
        <Stack.Screen
          name="CompleteProfile"
          component={CompleteProfileScreen}
        />
      </Stack.Navigator>
    );
  }

  // Autenticado: app principal. Header y fondo con el tema oscuro (Midnight Motion): sin esto
  // el header nativo sale BLANCO y rompe el diseño en las pantallas con `headerShown: true`.
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: true,
        headerStyle: {backgroundColor: theme.colors.bg},
        headerTintColor: theme.colors.ink,
        headerTitleStyle: {color: theme.colors.ink},
        headerShadowVisible: false,
        // Sin label junto al chevron de volver: iOS mostraba el NOMBRE DE RUTA interno ("Main")
        // al lado de la flecha — jerga de código filtrada al usuario (visto en el barrido pen↔sim).
        headerBackTitleVisible: false,
        contentStyle: {backgroundColor: theme.colors.bg},
      }}>
      {/* MAIN = bottom nav (Inicio·Viajes·Seguridad·Cuenta), reintroducido del design/veo.pen. Va
          PRIMERA (initialRoute de facto). Las pantallas modales/de viaje van ENCIMA en el Stack. */}
      <Stack.Screen
        name="Main"
        component={MainTabs}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="Search"
        component={SearchScreen}
        options={{headerShown: false, animation: 'slide_from_right'}}
      />
      <Stack.Screen
        name="RouteQuote"
        component={RouteQuoteScreen}
        options={{headerShown: false}}
      />
      <Stack.Screen
        name="MapPick"
        component={MapPickScreen}
        options={{headerShown: false, animation: 'slide_from_bottom'}}
      />
      <Stack.Screen
        name="OffersBoard"
        component={OffersBoardScreen}
        options={{title: t('screens.offersBoard')}}
      />
      <Stack.Screen
        name="Counter"
        component={CounterScreen}
        options={{title: t('screens.counter')}}
      />
      <Stack.Screen
        name="NoOffers"
        component={NoOffersScreen}
        options={{title: t('screens.noOffers')}}
      />
      <Stack.Screen
        name="TripActive"
        component={TripActiveScreen}
        options={{title: t('screens.tripActive')}}
      />
      {/* "Comparte tu viaje" (design/veo.pen zKyic): entra desde la acción Compartir del viaje activo. */}
      <Stack.Screen
        name="FamilyShare"
        component={FamilyShareScreen}
        options={{title: t('screens.familyShare')}}
      />
      {/* Control de cámara: header oscuro estándar, igual que el diseño CameraControl. */}
      <Stack.Screen
        name="CameraControl"
        component={CameraControlScreen}
        options={{title: t('screens.cameraControl')}}
      />
      <Stack.Screen
        name="ScheduledTrips"
        component={ScheduledTripsScreen}
        options={{title: t('screens.scheduledTrips')}}
      />
      <Stack.Screen
        name="ScheduleNew"
        component={ScheduleNewScreen}
        options={{title: t('screens.scheduleNew')}}
      />
      {/* Carpooling (ADR-014 · pen sección 5): buscador → resultados → detalle → reserva → estado. */}
      <Stack.Screen
        name="CarpoolSearch"
        component={CarpoolSearchScreen}
        options={{title: t('screens.carpoolSearch')}}
      />
      <Stack.Screen
        name="CarpoolResults"
        component={CarpoolResultsScreen}
        options={{title: t('screens.carpoolResults')}}
      />
      <Stack.Screen
        name="CarpoolTripDetail"
        component={CarpoolTripDetailScreen}
        options={{title: t('screens.carpoolTripDetail')}}
      />
      <Stack.Screen
        name="CarpoolBookingReview"
        component={CarpoolBookingReviewScreen}
        options={{title: t('screens.carpoolBookingReview')}}
      />
      <Stack.Screen
        name="CarpoolBookingStatus"
        component={CarpoolBookingStatusScreen}
        // Sin gesto de retroceso: se entra por replace tras el POST; volver es por los CTAs
        // explícitos ("Volver al inicio" / "Buscar otros viajes"), no por swipe accidental.
        options={{
          title: t('screens.carpoolBookingStatus'),
          gestureEnabled: false,
        }}
      />
      <Stack.Screen
        name="Notifications"
        component={NotificationsScreen}
        options={{title: t('screens.notifications')}}
      />
      {/* Preferencias de notificaciones (pen P/NotifPrefs): pantalla propia, distinta del feed. */}
      <Stack.Screen
        name="NotificationPrefs"
        component={NotificationPrefsScreen}
        options={{title: t('screens.notificationPrefs')}}
      />
      <Stack.Screen
        name="LostItem"
        component={LostItemScreen}
        options={{title: t('screens.lostItem')}}
      />
      {/* Reasignación (REASSIGNING): inmersiva, sin header del SO, sin gesto de retroceso —
          el flujo continúa al board de ofertas o cancela explícitamente. */}
      <Stack.Screen
        name="Reassign"
        component={ReassignScreen}
        options={{headerShown: false, gestureEnabled: false}}
      />
      <Stack.Screen
        name="TrustedContacts"
        component={TrustedContactsScreen}
        options={{title: t('screens.trustedContacts')}}
      />
      <Stack.Screen
        name="ChildMode"
        component={ChildModeScreen}
        options={{title: t('screens.childMode')}}
      />
      <Stack.Screen
        name="KycCamera"
        component={KycCameraScreen}
        options={{
          title: t('screens.kycCamera'),
          headerShown: false,
          animation: 'slide_from_bottom',
        }}
      />
      <Stack.Screen
        name="PaymentMethods"
        component={PaymentMethodsScreen}
        options={{title: t('screens.paymentMethods')}}
      />
      <Stack.Screen
        name="Payment"
        component={PaymentScreen}
        options={{title: t('screens.payment')}}
      />
      <Stack.Screen
        name="Rating"
        component={RatingScreen}
        options={{title: t('screens.rating')}}
      />
      <Stack.Screen
        name="SavedPlaces"
        component={SavedPlacesScreen}
        options={{title: t('screens.savedPlaces')}}
      />
      <Stack.Screen
        name="Referrals"
        component={ReferralsScreen}
        options={{title: t('screens.referrals')}}
      />
      <Stack.Screen
        name="Chat"
        component={ChatScreen}
        options={{title: t('screens.chat'), animation: 'slide_from_bottom'}}
      />
      <Stack.Screen
        name="Help"
        component={HelpScreen}
        options={{title: t('screens.help')}}
      />
      <Stack.Group
        screenOptions={{presentation: 'fullScreenModal', headerShown: false}}>
        {/* Cámara del viaje a pantalla completa (Ola 2A): modal full-screen, sin chrome del SO. */}
        <Stack.Screen name="CameraLive" component={CameraLiveScreen} />
        <Stack.Screen name="Panic" component={PanicScreen} />
      </Stack.Group>
    </Stack.Navigator>
  );
}
