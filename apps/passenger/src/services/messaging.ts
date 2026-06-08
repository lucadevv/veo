import type { FirebaseMessagingTypes } from '@react-native-firebase/messaging';
import { Platform } from 'react-native';
import { env } from '../core/config/env';
import { TOKENS } from '../core/di/tokens';
import { container } from '../core/di/registry';
import { resolveDeepLink } from '../features/notifications/domain/deepLink';
import type { PushPlatform } from '../features/notifications/domain/pushTokenRegistrar';
import { navigationRef } from '../navigation/navigationRef';

/**
 * Inicialización PROTEGIDA de push (FCM/APNs) + handlers foreground/background.
 *
 * API MODULAR v9 (`@react-native-firebase` ≥ v22 deprecó la namespaced `messaging().xxx`): se importan
 * las funciones sueltas (`getMessaging`, `getToken`, …) y operan sobre la instancia `getMessaging(getApp())`.
 *
 * Doble protección para que el scaffold NO falle al arrancar sin credenciales reales de Firebase:
 *   1. Gate por env (`FIREBASE_ENABLED`): debe activarse explícitamente.
 *   2. try/catch: cualquier error nativo (plist placeholder, etc.) se captura sin tumbar la app.
 *
 * Cuando hay credenciales reales y `FIREBASE_ENABLED=true`: pide permiso, obtiene el token, cablea
 * los handlers (primer plano, segundo plano, refresh de token) y ENTREGA el token al backend vía el
 * puerto `PushTokenRegistrar` (`POST /devices`). En logout se da de baja (`DELETE /devices/:token`).
 */

let backgroundHandlerSet = false;

/**
 * Topic FCM de promociones/novedades. Broadcast NO sensible: la suscripción client-side es aceptable
 * (un atacante suscrito solo recibiría promos). El opt-in legal lo registra el consent (Ley 29733).
 */
const PROMOS_TOPIC = 'promos';

/** Instancia modular de messaging (la que reciben las funciones `getToken(messaging)`, etc.). */
type Messaging = FirebaseMessagingTypes.Module;

function currentPlatform(): PushPlatform {
  return Platform.OS === 'ios' ? 'ios' : 'android';
}

/**
 * Resuelve la instancia modular de messaging cargando el SDK por import dinámico (respeta el gate:
 * el bundle de Firebase solo se carga cuando `FIREBASE_ENABLED=true`). Devuelve la instancia lista.
 */
async function loadMessaging(): Promise<Messaging> {
  const [{ getMessaging }, { getApp }] = await Promise.all([
    import('@react-native-firebase/messaging'),
    import('@react-native-firebase/app'),
  ]);
  return getMessaging(getApp());
}

/**
 * Suscribe/desuscribe al topic de promociones según el opt-in de marketing del pasajero. Best-effort:
 * no relanza (un fallo de red NO debe trabar el toggle; la fuente de verdad legal es el consent server).
 * No-op si Firebase está deshabilitado.
 */
export async function setPromotionsSubscription(enabled: boolean): Promise<void> {
  if (!env.firebaseEnabled) {
    return;
  }
  try {
    const { subscribeToTopic, unsubscribeFromTopic } = await import('@react-native-firebase/messaging');
    const messaging = await loadMessaging();
    await (enabled
      ? subscribeToTopic(messaging, PROMOS_TOPIC)
      : unsubscribeFromTopic(messaging, PROMOS_TOPIC));
  } catch (error) {
    console.warn('[messaging] no se pudo actualizar la suscripción a promociones:', error);
  }
}

/**
 * Registra el handler de mensajes en SEGUNDO PLANO. Debe llamarse en el arranque del proceso (fuera
 * del ciclo de React), por eso vive aquí y se invoca desde el bootstrap nativo.
 */
export async function registerBackgroundMessageHandler(): Promise<void> {
  if (!env.firebaseEnabled || backgroundHandlerSet) {
    return;
  }
  try {
    const { setBackgroundMessageHandler } = await import('@react-native-firebase/messaging');
    const messaging = await loadMessaging();
    // Handler de background REQUERIDO por RNFirebase para procesar data-messages headless. Hoy es no-op
    // deliberado (las notificaciones VISIBLES las presenta el sistema); acá iría el procesamiento data-only
    // futuro. NO logueamos: un mensaje normal no es un warning (era ruido que parecía error en Metro).
    setBackgroundMessageHandler(messaging, async () => {});
    backgroundHandlerSet = true;
  } catch (error) {
    console.warn('[messaging] no se pudo registrar el handler de background:', error);
  }
}

/**
 * Deep-link pendiente. Se mantiene hasta que la navegación REALMENTE pueda aterrizar: las pantallas de
 * viaje (OffersBoard/TripActive/NoOffers) SOLO existen en el stack autenticado+desbloqueado+perfil-completo
 * (RootNavigator). Si el push se toca con la sesión BLOQUEADA (BiometricLock, común en cold-start) o el
 * perfil incompleto, navegar sería un no-op silencioso y el deep-link se perdería. Por eso no lo navegamos
 * a ciegas: lo dejamos pendiente y `flushPendingDeepLink` reintenta en cada cambio de estado de navegación
 * (App.tsx `onReady` + `onStateChange`), aterrizando recién cuando la ruta destino está montada.
 */
let pendingDeepLink: FirebaseMessagingTypes.RemoteMessage | null = null;
let pendingDeepLinkAt = 0;

/**
 * R4 · caducidad del deep-link pendiente. Un deep-link de push solo es relevante poco después del tap; si
 * la ruta destino NUNCA llega a montarse (sesión que queda bloqueada o se cierra), el pendiente NO debe
 * dispararse sesiones después al entrar a OTRO viaje. Pasado este TTL se descarta.
 */
const DEEP_LINK_TTL_MS = 5 * 60_000;

/**
 * #1 · Deep-link al TOCAR un push. Lo encola (con timestamp) y dispara un intento de flush inmediato (caso
 * app abierta y autenticada). Si la ruta destino aún no está montada, queda pendiente para el próximo
 * `onStateChange` — pero caduca (R4) y se limpia en logout (R5), para no convertirse en un salto fantasma.
 */
function navigateFromPush(message: FirebaseMessagingTypes.RemoteMessage | null): void {
  if (!resolveDeepLink(message?.data)) return; // push sin deep-link resoluble: ignorar
  pendingDeepLink = message;
  pendingDeepLinkAt = Date.now();
  flushPendingDeepLink();
}

/**
 * Reintenta la navegación pendiente. Lo invoca `App.tsx` en `onReady` (cold-start) y `onStateChange`
 * (cuando el stack conmuta de no-autenticado/bloqueado → autenticado, montando las rutas de viaje).
 * NO consume el pendiente si la ruta destino todavía no existe en el navegador montado (sigue esperando),
 * SALVO que haya caducado (R4) → lo descarta para no saltar a un viaje viejo.
 */
export function flushPendingDeepLink(): void {
  if (!pendingDeepLink) return;
  if (Date.now() - pendingDeepLinkAt > DEEP_LINK_TTL_MS) {
    clearPendingDeepLink(); // R4 · deep-link rancio (nunca montó la ruta): caduca, no salta después
    return;
  }
  const target = resolveDeepLink(pendingDeepLink.data);
  if (!target) {
    clearPendingDeepLink(); // payload dejó de ser resoluble: descartar
    return;
  }
  if (!navigationRef.isReady()) return;
  // La ruta destino solo existe en el stack autenticado: si el navegador montado es Splash/Auth/
  // BiometricLock/CompleteProfile, esperá (no la consumas) hasta que conmute al stack de viaje.
  const routeNames = navigationRef.getRootState()?.routeNames ?? [];
  if (!routeNames.includes(target.screen)) return;
  clearPendingDeepLink();
  // Estrechamos el union del target (TS no co-estrecha screen+params en una sola llamada): el HOME del
  // sheet (Main/Home, puja EXPIRED) vs. las pantallas de viaje legacy (params `{ tripId }`).
  if (target.screen === 'Main') {
    navigationRef.navigate(target.screen, target.params);
  } else {
    navigationRef.navigate(target.screen, target.params as { tripId: string });
  }
}

/** R5 · limpia el deep-link pendiente. Se llama en logout: NO debe sobrevivir a un cambio de sesión. */
export function clearPendingDeepLink(): void {
  pendingDeepLink = null;
  pendingDeepLinkAt = 0;
}

/** Cablea los handlers de PRIMER PLANO y el refresh de token; entrega el token al backend. */
async function wireForeground(messaging: Messaging): Promise<void> {
  const { onMessage, onNotificationOpenedApp, onTokenRefresh } = await import(
    '@react-native-firebase/messaging'
  );
  const registrar = container.resolve(TOKENS.pushTokenRegistrar);

  // Mensajes con la app en PRIMER PLANO: no-op deliberado. NO auto-navegamos (el pasajero ya está usando la
  // app y un salto sería agresivo) y el banner lo presenta el sistema (willPresentNotification). El deep-link
  // se dispara al TOCAR la notificación (onNotificationOpenedApp / getInitialNotification). Handler registrado
  // porque RNFirebase lo exige para entregar el mensaje en foreground. NO logueamos: un mensaje normal no es
  // un warning (ese console.warn aparecía amarillo en Metro y se confundía con un error).
  onMessage(messaging, async () => {});

  // App en SEGUNDO PLANO y el usuario TOCA la notificación → la trae al frente: deep-link al board.
  onNotificationOpenedApp(messaging, (remoteMessage) => {
    navigateFromPush(remoteMessage);
  });

  // Rotación de token: re-registrar contra el backend.
  onTokenRefresh(messaging, (token: string) => {
    void registrar.register(token, currentPlatform());
  });
}

/**
 * Arranca el messaging: permisos + token + handlers. Devuelve el token FCM o null si no aplica.
 */
export async function initMessaging(): Promise<string | null> {
  if (!env.firebaseEnabled) {
    return null;
  }

  try {
    const {
      requestPermission,
      registerDeviceForRemoteMessages,
      getInitialNotification,
      getToken,
      AuthorizationStatus,
    } = await import('@react-native-firebase/messaging');
    const messaging = await loadMessaging();

    const authStatus = await requestPermission(messaging);
    const enabled =
      authStatus === AuthorizationStatus.AUTHORIZED ||
      authStatus === AuthorizationStatus.PROVISIONAL;

    if (!enabled) {
      return null;
    }

    await wireForeground(messaging);

    // iOS · registro EXPLÍCITO con APNs antes de pedir el token. RNFirebase auto-registra por
    // default, pero ese camino es implícito y con timing: en device físico `getToken()` puede correr
    // antes de que llegue el APNs token y lanzar "You must be registered for remote messages...".
    // Llamarlo explícito lo vuelve determinístico (idempotente: si ya está registrado, resuelve al toque).
    // En Android es no-op conceptual (FCM no usa APNs), por eso se gatea por plataforma.
    if (Platform.OS === 'ios') {
      await registerDeviceForRemoteMessages(messaging);
    }

    // Cold-start: si la app se abrió tocando un push (proceso muerto), navegá al deep-link en cuanto
    // monte el contenedor (lo retoma flushPendingDeepLink desde onReady).
    const initial = await getInitialNotification(messaging);
    if (initial) navigateFromPush(initial);

    const token = await getToken(messaging);
    const registrar = container.resolve(TOKENS.pushTokenRegistrar);
    await registrar.register(token, currentPlatform());
    return token;
  } catch (error) {
    // No relanzar: el arranque de la app no depende de FCM.
    console.warn('[messaging] inicialización de FCM omitida:', error);
    return null;
  }
}

/**
 * Da de baja el token de push del backend (logout). Obtiene el token FCM/APNs actual y llama al
 * puerto `PushTokenRegistrar` (`DELETE /devices/:token`). Best-effort: nunca relanza para no impedir
 * el cierre de sesión local. No-op si Firebase está deshabilitado.
 */
export async function unregisterMessaging(): Promise<void> {
  // R5 · el deep-link pendiente NO sobrevive al logout (antes del gate de Firebase: aplica aunque FCM esté
  // off). Sin esto, un deep-link encolado en la sesión anterior podía saltar al entrar a un viaje en la nueva.
  clearPendingDeepLink();
  if (!env.firebaseEnabled) {
    return;
  }
  try {
    const { getToken } = await import('@react-native-firebase/messaging');
    const messaging = await loadMessaging();
    const token = await getToken(messaging);
    const registrar = container.resolve(TOKENS.pushTokenRegistrar);
    await registrar.unregister(token);
  } catch (error) {
    console.warn('[messaging] baja del token de push omitida:', error);
  }
}
