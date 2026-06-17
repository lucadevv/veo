/**
 * Polyfills de Hermes para livekit-client 2.x (publisher de la cámara en vivo del viaje). Hermes no
 * trae varios globals web que livekit usa al EVALUAR su módulo, así que deben existir ANTES de
 * cualquier import que arrastre livekit-client. `registerGlobals()` de react-native-webrtc registra
 * RTCPeerConnection y cía, pero NO estos.
 *
 *  - TextEncoder/TextDecoder (text-encoding-polyfill): livekit los usa para serializar data-channel.
 *    Sin ellos: "Property 'TextDecoder' doesn't exist" al montar el LiveKitTripPublisher.
 *  - DOMException: livekit define clases que lo EXTIENDEN en el scope del módulo (DeferrableMapAbortError).
 *    Sin él: "Property 'DOMException' doesn't exist".
 */
import 'text-encoding-polyfill';

if (typeof globalThis.DOMException === 'undefined') {
  globalThis.DOMException = class DOMException extends Error {
    constructor(message, name) {
      super(message);
      this.name = name ?? 'Error';
    }
  };
}
