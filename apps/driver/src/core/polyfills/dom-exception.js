/**
 * Polyfill DOMException (Hermes no lo trae): livekit-client 2.x define clases que EXTIENDEN
 * DOMException en el scope del módulo (p. ej. DeferrableMapAbortError), o sea que el global debe
 * existir ANTES de evaluar cualquier import de livekit-client — sin esto el publisher del viaje
 * revienta con "Property 'DOMException' doesn't exist" al iniciar el viaje.
 * `registerGlobals()` de react-native-webrtc registra RTCPeerConnection y compañía, pero NO esto.
 */
if (typeof global.DOMException === 'undefined') {
  global.DOMException = class DOMException extends Error {
    constructor(message, name) {
      super(message);
      this.name = name ?? 'Error';
    }
  };
}
