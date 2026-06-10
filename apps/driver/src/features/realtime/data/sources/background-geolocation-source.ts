import {NativeModules} from 'react-native';
import type {
  default as BackgroundGeolocationModule,
  Location,
  Subscription,
} from 'react-native-background-geolocation';
import type {LocationSample, LocationSource} from '../../domain/location-source';

/**
 * Fuente de GPS nativa real sobre `react-native-background-geolocation` (Transistor Software, OSS,
 * empotrable y sin SaaS de terceros). Cumple el puerto `LocationSource` del dominio: emite muestras
 * en foreground y background, y el `useLocationPublisher` las reenvía por el socket `/driver`.
 *
 * Notas de plataforma:
 *  - Android: la propia librería levanta un Foreground Service de ubicación (FGS de tipo `location`),
 *    complementario al Foreground Service de turno (cámara/micro para WebRTC) que monta la app.
 *  - iOS: usa el background mode `location` ya declarado en `Info.plist`.
 *
 * Robustez: el módulo nativo (`RNBackgroundGeolocation`) solo existe si el build lo enlazó. Si NO está
 * (Jest, build parcial de QA, plataforma sin binario), `available` es `false`, la librería NO se carga
 * (el require es PEREZOSO, evitando que el `NativeEventEmitter` interno reviente al construirse con un
 * módulo `undefined`) y todas las operaciones son no-op silenciosas. No es un mock: simplemente no hay
 * GPS nativo y el publisher la ignora con seguridad (`source.available === false`).
 *
 * Diseño: `ready(config)` se llama UNA sola vez por arranque (requisito de la librería). La primera
 * suscripción configura e inicia el tracking; al cancelar la última suscripción se detiene.
 */

/** El módulo nativo solo está presente si el build enlazó la librería de background-geolocation. */
const nativeLinked = NativeModules.RNBackgroundGeolocation != null;

/** Carga perezosa de la librería: solo se importa si el módulo nativo está realmente enlazado. */
function loadLibrary(): typeof BackgroundGeolocationModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('react-native-background-geolocation').default;
}

export class BackgroundGeolocationSource implements LocationSource {
  /** true solo cuando el módulo nativo está enlazado en este build. */
  readonly available = nativeLinked;

  /** Listeners activos de la app (varios consumidores comparten una sola suscripción nativa). */
  private readonly listeners = new Set<(sample: LocationSample) => void>();
  /** Suscripción nativa al evento `onLocation` (una sola, multiplexada). */
  private nativeSub: Subscription | null = null;
  /** Suscripción a `onProviderChange`: la consumimos para que RN no advierta "no listeners registered". */
  private providerSub: Subscription | null = null;
  /** Garantiza que `ready()` se invoque una única vez por ciclo de vida del proceso. */
  private readyPromise: Promise<void> | null = null;
  /** Referencia memoizada a la librería nativa (solo se resuelve si está enlazada). */
  private library: typeof BackgroundGeolocationModule | null = null;

  subscribe(listener: (sample: LocationSample) => void): () => void {
    if (!this.available) {
      // Sin GPS nativo: registramos el listener por consistencia, pero nunca emitirá.
      return () => undefined;
    }

    this.listeners.add(listener);
    this.ensureStarted().catch(() => undefined);

    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.stop().catch(() => undefined);
      }
    };
  }

  /** Resuelve (y memoiza) la librería nativa. Solo se invoca cuando `available === true`. */
  private get bg(): typeof BackgroundGeolocationModule {
    if (!this.library) {
      this.library = loadLibrary();
    }
    return this.library;
  }

  /** Configura e inicia el tracking nativo si aún no está activo (idempotente). */
  private async ensureStarted(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.configure();
    }
    await this.readyPromise;
    await this.bg.start();
    // Fuerza el estado "moving" para emitir ubicaciones de inmediato al iniciar turno/viaje.
    await this.bg.changePace(true);
  }

  /** Registra el listener nativo y aplica la configuración de tracking (una sola vez). */
  private async configure(): Promise<void> {
    const bg = this.bg;
    if (!this.nativeSub) {
      // El 2do argumento (failure) es OBLIGATORIO en la práctica: sin él, la librería entrega los
      // errores transitorios de GPS al callback de éxito como `{error}` SIN `coords` (NativeModule.js
      // addListener) y reventaría el dispatch. Un error puntual no corta el tracking: se ignora.
      this.nativeSub = bg.onLocation(
        (location: Location) => {
          this.dispatch(location);
        },
        () => undefined,
      );
      // El SDK emite `providerchange` (RCTDeviceEventEmitter) al hacer `ready()`/cambiar el proveedor.
      // Sin listener, RN advierte "Sending `providerchange` with no listeners registered" (benigno
      // pero ruidoso). Lo consumimos; la degradación por permisos la maneja el flujo de turno.
      this.providerSub = bg.onProviderChange(() => undefined);
    }

    await bg.ready({
      desiredAccuracy: bg.DESIRED_ACCURACY_HIGH,
      distanceFilter: 10,
      // No detener el tracking al cerrar la app: el turno sigue activo en background.
      stopOnTerminate: false,
      startOnBoot: false,
      // Android: la librería gestiona su propio Foreground Service de ubicación.
      enableHeadless: false,
      foregroundService: true,
      notification: {
        title: 'VEO Conductor',
        text: 'Compartiendo tu ubicación durante el turno activo.',
      },
      // iOS: solicitamos autorización "Always" para el seguimiento en background.
      locationAuthorizationRequest: 'Always',
      backgroundPermissionRationale: {
        title: 'Permitir ubicación en segundo plano',
        message:
          'VEO necesita tu ubicación incluso con la app cerrada para mantener el seguimiento del turno y los viajes.',
        positiveAction: 'Permitir',
        negativeAction: 'Cancelar',
      },
      // Sin SaaS: deshabilitamos el endpoint HTTP de Transistor; el envío lo hace el socket `/driver`.
      url: undefined,
      autoSync: false,
      debug: false,
      logLevel: bg.LOG_LEVEL_OFF,
    });
  }

  /** Convierte la `Location` nativa a `LocationSample` del dominio y notifica a los listeners. */
  private dispatch(location: Location): void {
    const {coords} = location;
    // Cinturón y tirantes: cualquier payload sin coords (error/evento no-ubicación) se descarta.
    if (!coords) {
      return;
    }
    const sample: LocationSample = {
      lat: coords.latitude,
      lon: coords.longitude,
      heading: coords.heading ?? null,
      speed: coords.speed ?? null,
      accuracy: coords.accuracy ?? null,
      ts: location.timestamp,
    };
    this.listeners.forEach(listener => listener(sample));
  }

  /** Detiene el tracking nativo cuando ya no quedan consumidores. */
  private async stop(): Promise<void> {
    try {
      await this.bg.stop();
    } catch {
      // El stop puede rechazar si el módulo aún no estaba iniciado; es seguro ignorarlo.
    }
  }
}

/** Instancia singleton: una sola suscripción nativa multiplexada para toda la app. */
export const backgroundGeolocationSource: LocationSource = new BackgroundGeolocationSource();
