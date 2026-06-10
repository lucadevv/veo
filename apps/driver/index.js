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
import 'react-native-gesture-handler';
import {registerGlobals} from 'react-native-webrtc';
import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';
import {registerPushBackgroundHandler} from './src/features/notifications/data';
import {initSecureStorage} from './src/core/storage/mmkv';
import {initMapbox} from './src/core/maps/mapbox';

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

AppRegistry.registerComponent(appName, () => App);
