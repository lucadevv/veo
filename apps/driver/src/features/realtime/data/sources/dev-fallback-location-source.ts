import type {
  LocationAvailability,
  LocationSample,
  LocationSource,
} from '../../../../core/location/location-source';

/** Tiempo de gracia para que el GPS nativo emita su primera muestra antes de caer al stub (ms). */
const NATIVE_GRACE_MS = 4000;

/**
 * Fuente de ubicación de DEV con FALLBACK automático (SOLO dev, instalada por el selector).
 *
 * Problema: en el simulador iOS el módulo nativo de background-geolocation ESTÁ enlazado
 * (`available === true`) pero NO emite muestras → la app no publica posición. No se puede distinguir
 * "sim sin GPS" de "device con GPS" solo por `available`. Solución: en dev, suscribimos al nativo y, si
 * NO llega ninguna muestra en `NATIVE_GRACE_MS`, caemos al STUB que "maneja" una posición sintética. Si
 * el nativo emite (device real), usamos el nativo y el stub nunca arranca. Si el nativo ni siquiera está
 * enlazado, vamos directo al stub. En RELEASE el selector NO usa esta clase (nativo puro), riesgo cero.
 */
export class DevFallbackLocationSource implements LocationSource {
  readonly available = true;

  constructor(
    private readonly native: LocationSource,
    private readonly stub: LocationSource,
    private readonly graceMs: number = NATIVE_GRACE_MS,
  ) {}

  subscribe(listener: (sample: LocationSample) => void): () => void {
    // Sin módulo nativo enlazado: directo al stub (sin esperar la gracia).
    if (!this.native.available) {
      return this.stub.subscribe(listener);
    }

    let gotNative = false;
    let stubCleanup: (() => void) | null = null;

    const nativeCleanup = this.native.subscribe((sample) => {
      gotNative = true;
      // El nativo despertó: si ya habíamos caído al stub, lo cortamos (gana el GPS real).
      if (stubCleanup) {
        stubCleanup();
        stubCleanup = null;
      }
      listener(sample);
    });

    const timer = setTimeout(() => {
      if (!gotNative) {
        // Nativo en silencio (simulador) → caer al stub.
        stubCleanup = this.stub.subscribe(listener);
      }
    }, this.graceMs);

    return () => {
      clearTimeout(timer);
      nativeCleanup();
      if (stubCleanup) {
        stubCleanup();
      }
    };
  }

  onAvailabilityChange(listener: (availability: LocationAvailability) => void): () => void {
    // Con stub o nativo, en dev la disponibilidad operativa es true (no bloquear la UI del turno).
    if (!this.native.available) {
      return this.stub.onAvailabilityChange(listener);
    }
    return this.native.onAvailabilityChange(listener);
  }
}
