import type { LocationSource } from '../../domain/location-source';
import { backgroundGeolocationSource } from './background-geolocation-source';
import { stubLocationSource } from './stub-location-source';
import { DevFallbackLocationSource } from './dev-fallback-location-source';

/**
 * Elige la fuente de GPS.
 *
 * - RELEASE (`__DEV__` false): SIEMPRE la nativa (background-geolocation), sin envoltorios → riesgo cero.
 * - DEV: la fuente nativa CON FALLBACK al stub. El módulo nativo está enlazado también en el simulador
 *   (`available === true`) pero NO emite muestras ahí; el fallback detecta ese silencio y cae al stub que
 *   "maneja" una posición sintética, para ver el flujo de ubicación (taxi del pasajero + auto del conductor
 *   + cámara Waze) en el simulador. En un device real el nativo emite y el stub nunca arranca.
 *
 * Espeja el patrón del biométrico (`selectFrameGrabber`), adaptado a que acá el módulo nativo SÍ está
 * enlazado: no alcanza con `!nativeLinked`, hay que detectar el silencio en runtime.
 */
export function selectLocationSource(): LocationSource {
  if (__DEV__) {
    return new DevFallbackLocationSource(backgroundGeolocationSource, stubLocationSource);
  }
  return backgroundGeolocationSource;
}
