/**
 * @format
 */

// Polyfill CSPRNG (debe ir PRIMERO): expone global.crypto.getRandomValues, que usa
// `secure-encryption-key` para generar la clave de cifrado MMKV con aleatoriedad criptográfica.
import 'react-native-get-random-values';
// Polyfill Intl.PluralRules (Hermes no lo trae): SIN esto i18next cae al formato v3 y busca claves
// `_plural`, pero las traducciones usan el formato v4 (`_one`/`_other`) → plurales ROTOS en runtime
// (además del error "i18next::pluralResolver" en el arranque). Debe ir ANTES de cargar i18n.
import 'intl-pluralrules';
import 'react-native-gesture-handler';
import { AppRegistry } from 'react-native';
// Bootstrap de la capa NATIVA (WebRTC globals, visor LiveKit, handler push background).
import './src/bootstrap/native';
import App from './src/App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
