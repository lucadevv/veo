import { LogBox } from 'react-native';
import { registerGlobals } from 'react-native-webrtc';
import { LiveKitCabinViewer } from '../features/trip/presentation/components/LiveKitCabinViewer';
import { registerCabinVideoViewer } from '../features/trip/presentation/ports/cabinVideoViewer';
import { registerBackgroundMessageHandler } from '../services/messaging';
import { initMapbox } from '../core/maps/mapbox';

/**
 * Bootstrap de la capa NATIVA (efectos de arranque, fuera del ciclo de React).
 *
 * Se importa desde `index.js` (no desde `App.tsx`) para que solo se ejecute en el runtime nativo y
 * no en entornos sin capa nativa (p. ej. Jest). Hace tres cosas:
 *  1. Registra los globals de WebRTC (`react-native-webrtc`) que necesita `livekit-client`.
 *  2. Registra el visor REAL del habitáculo (LiveKit) en el puerto `CabinVideoViewer`.
 *  3. Registra el handler de mensajes push en SEGUNDO PLANO (debe hacerse al cargar el proceso).
 *  4. Deriva la `encryptionKey` del almacén seguro desde Keychain/Keystore y re-cifra MMKV.
 */

// 0) Silencia warnings BENIGNOS conocidos de `react-native-background-geolocation`: el SDK emite
// sus eventos (`location`, `providerchange`, `motionchange`, `activitychange`, `heartbeat`…) aunque
// no haya un listener JS registrado (la Home usa `getCurrentPosition` one-shot, no `watchPosition`).
// NO oculta errores reales — solo el patrón "Sending `<evento>` with no listeners registered".
LogBox.ignoreLogs([/Sending .+ with no listeners registered/]);

// 1) WebRTC para livekit-client.
registerGlobals();

// 2) Visor del habitáculo (LiveKit sobre react-native-webrtc).
registerCabinVideoViewer(LiveKitCabinViewer);

// 3) Push en segundo plano (gateado por FIREBASE_ENABLED dentro de la función).
void registerBackgroundMessageHandler();

// 5) Mapbox: registra el token público (pk.) en el SDK nativo ANTES de montar cualquier MapView.
// A nivel de módulo (fuera de React) para que el primer render del mapa ya tenga token.
initMapbox();

// 4) Seguridad del almacén: `initSecureStorage()` se llama (y se ESPERA) en App.tsx, encadenada a
// `hydrate()`. Crea la instancia MMKV segura con la clave del Keychain de forma ASYNC; debe
// completar ANTES de leer tokens, por eso NO se dispara acá (fire-and-forget sería un race contra
// la hidratación y, peor, antes se creaba con una clave de arranque que no descifraba la sesión).
