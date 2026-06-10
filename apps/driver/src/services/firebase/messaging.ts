/**
 * Inicialización PROTEGIDA de Firebase Cloud Messaging.
 *
 * El proyecto se entrega con credenciales placeholder (google-services.json /
 * GoogleService-Info.plist). Esta capa garantiza que la app NO crashee cuando
 * Firebase no está configurado con credenciales reales: cualquier fallo de
 * inicialización se captura y se degrada de forma silenciosa.
 *
 * Cuando se inyecten las credenciales reales en CI/CD, esta misma función
 * solicitará permisos y devolverá el token FCM sin cambios de código.
 */

let cachedToken: string | null = null;

const isFirebaseAvailable = (): boolean => {
  try {
    // Carga diferida: si el módulo nativo no está enlazado, no rompe el arranque. require (no import
    // estático) a propósito, dentro del try/catch, para degradar si el nativo falta.
    // API MODULAR (la namespaced `firebase.apps` está deprecada en RNFB v22+ y loguea warning):
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getApps } = require('@react-native-firebase/app') as { getApps: () => unknown[] };
    return getApps().length > 0;
  } catch {
    return false;
  }
};

/**
 * Solicita permisos e inicializa messaging. Devuelve el token FCM o null si
 * Firebase no está disponible / configurado.
 */
export const initMessaging = async (): Promise<string | null> => {
  if (!isFirebaseAvailable()) {
    if (__DEV__) {
      console.warn('[VEO] Firebase no configurado: messaging deshabilitado (placeholder).');
    }
    return null;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const messaging = require('@react-native-firebase/messaging').default;
    const authStatus = await messaging().requestPermission();
    const enabled =
      authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
      authStatus === messaging.AuthorizationStatus.PROVISIONAL;

    if (!enabled) {
      return null;
    }

    cachedToken = await messaging().getToken();
    return cachedToken;
  } catch (error) {
    if (__DEV__) {
      console.warn('[VEO] No se pudo inicializar messaging:', error);
    }
    return null;
  }
};

export const getCachedFcmToken = (): string | null => cachedToken;
