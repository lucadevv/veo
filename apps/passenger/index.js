/**
 * @format
 */

// Polyfill CSPRNG (debe ir PRIMERO): expone global.crypto.getRandomValues, que usa
// `secure-encryption-key` para generar la clave de cifrado MMKV con aleatoriedad criptográfica.
import 'react-native-get-random-values';
import 'react-native-gesture-handler';
import { AppRegistry } from 'react-native';
// Bootstrap de la capa NATIVA (WebRTC globals, visor LiveKit, handler push background).
import './src/bootstrap/native';
import App from './src/App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
