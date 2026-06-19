import { Platform } from 'react-native';
import type {
  DevicePlatform,
  OnPushDataMessage,
  PushMessage,
  PushRegistrationPort,
  PushService,
} from '../domain/ports/push';

/** Claves de `data` que NUNCA deben producir UI visible en el conductor (regla #2). */
const PANIC_DATA_HINTS = ['panic', 'sos', 'emergency', 'panico'];

/** No-op para cuando Firebase no está configurado (placeholder) o no hay permiso. */
const NOOP = (): void => undefined;

/** Instancia de messaging (subconjunto del API de @react-native-firebase/messaging que usamos). */
interface MessagingInstance {
  requestPermission(): Promise<number>;
  getToken(): Promise<string>;
  onTokenRefresh(listener: (token: string) => void): () => void;
  onMessage(listener: (message: PushMessage) => Promise<void> | void): () => void;
  onNotificationOpenedApp(listener: (message: PushMessage) => void): () => void;
  getInitialNotification(): Promise<PushMessage | null>;
  setBackgroundMessageHandler(handler: (message: PushMessage) => Promise<void>): void;
}

/** Módulo estático de messaging (factory + enum de autorización). */
interface MessagingModule {
  (): MessagingInstance;
  AuthorizationStatus: { AUTHORIZED: number; PROVISIONAL: number };
}

/**
 * Carga diferida y protegida del módulo de messaging: si el SDK nativo no está enlazado o Firebase no
 * está configurado, devuelve `null` sin romper el arranque (modo dev sandbox/log).
 */
function loadMessaging(): MessagingModule | null {
  try {
    // require lazy/opcional: el módulo nativo puede no estar presente (degradación honesta). Va dentro
    // del try/catch a propósito; un import estático tiraría al CARGAR el módulo si el nativo falta.
    // API MODULAR (la namespaced `firebase.apps` está deprecada en RNFB v22+ y loguea warning):
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getApps } = require('@react-native-firebase/app') as { getApps: () => unknown[] };
    if (getApps().length === 0) {
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@react-native-firebase/messaging').default as MessagingModule;
  } catch {
    return null;
  }
}

/** true si el mensaje parece relacionado con pánico del pasajero (no debe mostrarse). */
function isPanicMessage(message: PushMessage): boolean {
  const type = (message.data?.type ?? '').toLowerCase();
  return PANIC_DATA_HINTS.some((hint) => type.includes(hint));
}

/**
 * Servicio de push sobre `@react-native-firebase/messaging` (FCM en Android, APNs vía FCM en iOS).
 *
 * Maneja permisos, token, registro/baja en backend y handlers foreground/quita. El handler de
 * background se registra aparte a nivel de módulo (ver `registerPushBackgroundHandler`).
 *
 * Compliance: ningún handler muestra alertas. Los mensajes de pánico se descartan en la UI del
 * conductor (regla #2: UI engañosa). Si Firebase no está configurado (sandbox sin credenciales)
 * degrada en modo log y no registra nada (no se inventa token).
 */
export class FcmPushService implements PushService {
  /** Último token FCM/APNs conocido; permite darlo de baja en el logout (mientras el JWT vive). */
  private currentToken: string | null = null;

  async start(
    register: PushRegistrationPort,
    onDataMessage?: OnPushDataMessage,
  ): Promise<() => void> {
    const messaging = loadMessaging();
    if (!messaging) {
      if (__DEV__) {
        console.warn('[VEO] Push deshabilitado: Firebase no configurado (placeholder).');
      }
      return NOOP;
    }

    /**
     * Procesa un push NO sensible (pánico filtrado): loguea en dev y delega el `data` a la presentación
     * (refetch). NO muestra UI (regla #2). Único punto de manejo para foreground/abierto/quit.
     */
    const handleRelevant = (message: PushMessage): void => {
      if (isPanicMessage(message)) {
        return;
      }
      if (__DEV__) {
        console.warn('[VEO] Push:', message?.data);
      }
      onDataMessage?.(message.data);
    };

    try {
      const authStatus = await messaging().requestPermission();
      const granted =
        authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
        authStatus === messaging.AuthorizationStatus.PROVISIONAL;
      if (!granted) {
        return NOOP;
      }

      const platform: DevicePlatform = Platform.OS === 'ios' ? 'ios' : 'android';
      const token = await messaging().getToken();
      if (token) {
        this.currentToken = token;
        // Registro real contra el driver-bff; el fallo se degrada en log (no rompe la app).
        await register.registerDeviceToken({ token, platform }).catch((error: unknown) => {
          if (__DEV__) {
            console.warn('[VEO] No se pudo registrar el device token:', error);
          }
        });
      }

      // Re-registra el token cuando FCM lo rota.
      const unsubscribeRefresh = messaging().onTokenRefresh((next: string) => {
        this.currentToken = next;
        register.registerDeviceToken({ token: next, platform }).catch(() => undefined);
      });

      // Foreground: solo procesamos mensajes inocuos; los de pánico se ignoran (sin UI).
      const unsubscribeForeground = messaging().onMessage(async (remoteMessage: PushMessage) => {
        handleRelevant(remoteMessage);
      });

      // App abierta desde la notificación (quita/background→foreground): mismo filtro de pánico.
      const unsubscribeOpened = messaging().onNotificationOpenedApp((remoteMessage: PushMessage) => {
        handleRelevant(remoteMessage);
      });

      // Notificación que arrancó la app desde estado "quit".
      messaging()
        .getInitialNotification()
        .then((remoteMessage: PushMessage | null) => {
          if (remoteMessage) {
            handleRelevant(remoteMessage);
          }
        })
        .catch(() => undefined);

      return () => {
        unsubscribeRefresh?.();
        unsubscribeForeground?.();
        unsubscribeOpened?.();
      };
    } catch (error) {
      if (__DEV__) {
        console.warn('[VEO] No se pudo inicializar push:', error);
      }
      return NOOP;
    }
  }

  async unregisterCurrentToken(register: PushRegistrationPort): Promise<void> {
    // Toma el token recordado o, si no hay, lo consulta (idempotente) antes de darlo de baja.
    let token = this.currentToken;
    if (!token) {
      const messaging = loadMessaging();
      if (!messaging) {
        return;
      }
      token = await messaging()
        .getToken()
        .catch(() => null);
    }
    if (!token) {
      return;
    }
    try {
      await register.unregisterDeviceToken(token);
    } catch (error) {
      if (__DEV__) {
        console.warn('[VEO] No se pudo dar de baja el device token:', error);
      }
    } finally {
      this.currentToken = null;
    }
  }
}

/**
 * Registra el handler de mensajes en BACKGROUND. Debe llamarse a nivel de módulo (index.js), fuera del
 * ciclo de React. Guardado para no romper si Firebase no está configurado.
 */
export function registerPushBackgroundHandler(): void {
  const messaging = loadMessaging();
  if (!messaging) {
    return;
  }
  messaging().setBackgroundMessageHandler(async (remoteMessage: PushMessage) => {
    // Background: no se muestra nada; los mensajes de pánico se ignoran (regla #2).
    if (isPanicMessage(remoteMessage)) {
      return;
    }
    // Aquí se procesarían datos no sensibles (p. ej. refrescar caché). Sin UI.
  });
}

/** Singleton del servicio de push. */
export const fcmPushService: PushService = new FcmPushService();
