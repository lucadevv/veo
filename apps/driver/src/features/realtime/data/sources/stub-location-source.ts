import type {
  LocationAvailability,
  LocationSample,
  LocationSource,
} from '../../../../core/location/location-source';

/**
 * Fuente de ubicación STUB — SOLO dev (simulador sin GPS nativo).
 *
 * El módulo nativo de background-geolocation (transistorsoft) NO emite muestras en el simulador iOS, así
 * que la app del conductor nunca publicaba su posición → el conductor no aparecía como taxi en el mapa del
 * pasajero NI veía su auto en su propio mapa. Este stub emite una posición sintética que "maneja" un lazo
 * lento alrededor de un punto de Lima, para que TODO el flujo de ubicación (publisher → hot index de
 * dispatch → feed `nearby`; y `useDriverPose`/`useDriverLocation` → pin del auto + cámara tipo Waze) se vea
 * en el simulador. Espeja `StubBiometricFrameGrabber`: `__DEV__`-gated por el selector, NUNCA en release.
 *
 * Para mover al conductor a otra zona (que caiga cerca del pasajero de la demo), cambiá `DEV_DRIVER_CENTER`.
 */

/** Centro del recorrido del conductor de dev. Lima centro por defecto (ajustable para la demo). */
const DEV_DRIVER_CENTER = { lat: -12.0464, lon: -77.0428 };
/** Radio del lazo en metros (movimiento perceptible sin alejarse). */
const LOOP_RADIUS_M = 120;
/** Cada cuánto emite una muestra (ms). ~2.5s = fluido sin saturar el socket. */
const TICK_MS = 2500;
/** Avance angular por tick (rad). ~18°/tick → una vuelta completa en ~50s. */
const ANGLE_STEP = Math.PI / 10;
/** Velocidad sintética reportada (m/s) ≈ vuelta lenta de ciudad. */
const STUB_SPEED_MPS = 6;

const METERS_PER_DEG_LAT = 111_320;

/** Convierte un offset en metros (norte/este) a grados lat/lon en `center`. */
function offsetToLatLon(angle: number): { lat: number; lon: number } {
  const north = LOOP_RADIUS_M * Math.cos(angle);
  const east = LOOP_RADIUS_M * Math.sin(angle);
  const lat = DEV_DRIVER_CENTER.lat + north / METERS_PER_DEG_LAT;
  const lon =
    DEV_DRIVER_CENTER.lon +
    east / (METERS_PER_DEG_LAT * Math.cos((DEV_DRIVER_CENTER.lat * Math.PI) / 180));
  return { lat, lon };
}

/** Rumbo (0=N, 90=E) del segmento previo→actual, en grados [0,360). */
function bearing(from: { lat: number; lon: number }, to: { lat: number; lon: number }): number {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLon = toRad(to.lon - from.lon);
  const y = Math.sin(dLon) * Math.cos(toRad(to.lat));
  const x =
    Math.cos(toRad(from.lat)) * Math.sin(toRad(to.lat)) -
    Math.sin(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Stub que emite una posición que "maneja" un lazo. Comparte UN solo ticker entre todos los suscriptores
 * (publisher + pose + location): arranca con el primer `subscribe` y se detiene con el último `unsubscribe`,
 * igual que la fuente nativa (no abre un timer por consumidor).
 */
class StubLocationSource implements LocationSource {
  readonly available = true;

  private readonly listeners = new Set<(sample: LocationSample) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private angle = 0;
  private last: { lat: number; lon: number } = offsetToLatLon(0);

  subscribe(listener: (sample: LocationSample) => void): () => void {
    this.listeners.add(listener);
    // Muestra inmediata para el nuevo suscriptor (no esperar al primer tick).
    listener(
      this.buildSample(this.last, bearing(this.last, offsetToLatLon(this.angle + ANGLE_STEP))),
    );
    this.ensureTicking();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  onAvailabilityChange(listener: (availability: LocationAvailability) => void): () => void {
    // En el simulador el stub está siempre "disponible" (servicios + permiso simulados en true).
    listener({ servicesEnabled: true, permissionGranted: true });
    return () => undefined;
  }

  private ensureTicking(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      this.angle += ANGLE_STEP;
      const next = offsetToLatLon(this.angle);
      const heading = bearing(this.last, next);
      this.last = next;
      const sample = this.buildSample(next, heading);
      this.listeners.forEach((l) => l(sample));
    }, TICK_MS);
  }

  private buildSample(point: { lat: number; lon: number }, heading: number): LocationSample {
    return {
      lat: point.lat,
      lon: point.lon,
      heading,
      speed: STUB_SPEED_MPS,
      accuracy: 5,
      ts: new Date().toISOString(),
    };
  }
}

export const stubLocationSource: LocationSource = new StubLocationSource();
