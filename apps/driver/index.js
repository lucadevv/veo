/**
 * @format
 */

// Polyfill CSPRNG (debe ir PRIMERO): expone global.crypto.getRandomValues, que usa
// `secure-encryption-key` para generar la clave de cifrado MMKV con aleatoriedad criptográfica.
import 'react-native-get-random-values';
// Polyfill Intl.PluralRules (Hermes no lo trae): SIN esto i18next cae al formato v3 y busca claves
// `_plural`, pero nuestras traducciones usan el formato v4 (`_one`/`_other`) → plurales ROTOS en
// runtime (además del error "i18next::pluralResolver" en el arranque). Debe ir ANTES de cargar i18n.
import 'intl-pluralrules';
// Polyfill DOMException (Hermes no lo trae): livekit-client extiende DOMException al evaluarse el
// módulo, así que el global debe existir ANTES de cualquier import que arrastre livekit-client.
import './src/core/polyfills/dom-exception';
import 'react-native-gesture-handler';
import { registerGlobals } from 'react-native-webrtc';
import * as ReactNative from 'react-native';
import { AppRegistry } from 'react-native';
import App from './App';
import { BIOMETRIC_CAMERA_PREVIEW_NAME } from './src/features/registration/presentation';
import { name as appName } from './app.json';
import { registerPushBackgroundHandler } from './src/features/notifications/data';
import { initSecureStorage } from './src/core/storage/mmkv';
import { initMapbox } from './src/core/maps/mapbox';

// Globals WebRTC que necesita `livekit-client` (publisher del habitáculo). Debe ejecutarse a nivel de
// módulo, antes de montar la app, fuera de React (no se carga en Jest, que no importa index.js).
registerGlobals();

// Handler de mensajes push en background/quita. Debe registrarse fuera de React (nivel de módulo).
// Guardado: no rompe si Firebase no está configurado (placeholder de dev).
registerPushBackgroundHandler();

// Seguridad del almacén: deriva la encryptionKey del Keychain/Keystore y re-cifra el almacén
// seguro ANTES de que la app rehidrate la sesión (los tokens se leen en un efecto de React,
// posterior a este nivel de módulo). Fallback controlado dentro; no bloquea el arranque.
void initSecureStorage();

// Mapbox: registra el token público (pk.) en el SDK nativo antes de montar cualquier MapView.
// A nivel de módulo (fuera de React) para que el primer render del mapa ya tenga token.
initMapbox();

// New Architecture (Fabric) · interop de vistas LEGACY:
// La preview biométrica (`BiometricCameraPreview`) es un `SimpleViewManager` legacy y el proyecto corre
// `newArchEnabled=true`. En RN 0.85.3 el interop legacy de Fabric es AUTOMÁTICO (flag `useFabricInterop`
// por defecto en true) y resuelve la vista por reflexión sobre los ViewManagers registrados: NO existe
// `unstable_reactLegacyComponentNames` (verificado: cero ocurrencias en node_modules/react-native), ese
// array fue una clave de `react-native.config.js` previa a RN 0.74, obsoleta desde entonces.
//
// Por compatibilidad defensiva (si el día de mañana el RN del proyecto reexpone la API, o se cambia de
// versión), si EXISTE alguna de las entradas históricas para listar nombres legacy, la invocamos con el
// nombre del componente. Si no existe (caso de 0.85.3, lo normal), es un no-op silencioso: el interop
// automático ya monta la vista. Nunca lanza.
registerLegacyInteropComponent(BIOMETRIC_CAMERA_PREVIEW_NAME);

AppRegistry.registerComponent(appName, () => App);

/**
 * Registra (best-effort) un nombre de componente nativo legacy en el interop de Fabric, probando las
 * entradas históricas que RN ha usado para esto. En RN 0.85.3 ninguna existe y la función no hace nada
 * (el interop es automático). Guardada: cualquier fallo se traga para no romper el arranque.
 */
function registerLegacyInteropComponent(name) {
  try {
    const candidate =
      ReactNative.unstable_setLegacyComponentNames ||
      ReactNative.unstable_reactLegacyComponentNames ||
      (ReactNative.UIManager && ReactNative.UIManager.unstable_setLegacyComponentNames);
    if (typeof candidate === 'function') {
      candidate([name]);
    } else if (Array.isArray(ReactNative.unstable_reactLegacyComponentNames)) {
      // Variante histórica como ARRAY mutable expuesto por el módulo.
      if (!ReactNative.unstable_reactLegacyComponentNames.includes(name)) {
        ReactNative.unstable_reactLegacyComponentNames.push(name);
      }
    }
  } catch {
    // No-op: en 0.85.3 el interop legacy es automático; cualquier ausencia/error aquí es esperado.
  }
}
