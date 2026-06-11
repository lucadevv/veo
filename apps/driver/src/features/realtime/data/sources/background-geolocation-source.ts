import {NativeModules} from 'react-native';
// v5: los enums DesiredAccuracy/LogLevel se importan del paquete de TYPES, NO de
// react-native-background-geolocation. Razón (verificado en runtime): el paquete principal re-exporta
// los TIPOS pero NO los VALORES de los enums → `DesiredAccuracy` sería `undefined` en runtime y
// `DesiredAccuracy.High` crashea ("cannot read property 'High' of undefined"). @transistorsoft/...-types
// sí los exporta como valores (DesiredAccuracy={High:-1,...}). Los typings/valores son idénticos.
import {
  AuthorizationStatus,
  DesiredAccuracy,
  LogLevel,
} from '@transistorsoft/background-geolocation-types';
import type {
  default as BackgroundGeolocationModule,
  Location,
  ProviderChangeEvent,
  Subscription,
} from 'react-native-background-geolocation';
import type {
  LocationAvailability,
  LocationSample,
  LocationSource,
} from '../../domain/location-source';

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
  /** Listeners de DISPONIBILIDAD del GPS (servicios del SO + permiso), multiplexados igual que los de muestra. */
  private readonly availabilityListeners = new Set<
    (availability: LocationAvailability) => void
  >();
  /** Suscripción nativa al evento `onLocation` (una sola, multiplexada). */
  private nativeSub: Subscription | null = null;
  /** Suscripción a `onProviderChange`: alimenta a los `availabilityListeners` (una sola, multiplexada). */
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

  onAvailabilityChange(
    listener: (availability: LocationAvailability) => void,
  ): () => void {
    if (!this.available) {
      // Sin GPS nativo (Jest/build parcial): no hay proveedor que observar.
      return () => undefined;
    }

    this.availabilityListeners.add(listener);
    this.ensureProviderListener();
    // Emitimos el estado ACTUAL al suscribirse (no esperamos a un cambio): si el conductor ya tenía
    // la ubicación apagada al abrir el dashboard, el aviso debe salir de inmediato.
    this.bg
      .getProviderState()
      .then(state => listener(toAvailability(state)))
      .catch(() => undefined);

    return () => {
      this.availabilityListeners.delete(listener);
    };
  }

  /**
   * Registra (una sola vez) la suscripción nativa a `onProviderChange` que alimenta a los
   * `availabilityListeners`. Independiente del tracking: observar la disponibilidad NO arranca el GPS.
   */
  private ensureProviderListener(): void {
    if (!this.providerSub) {
      this.providerSub = this.bg.onProviderChange(event => {
        const availability = toAvailability(event);
        this.availabilityListeners.forEach(l => l(availability));
      });
    }
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
      // Lo consumimos para alimentar a los `availabilityListeners` (y de paso silenciar el aviso de RN
      // "Sending `providerchange` with no listeners registered"): la degradación por permisos/servicios
      // apagados en pleno turno la refleja la UI vía `onAvailabilityChange`.
      this.ensureProviderListener();
    }

    // Typings inconsistentes en v5.1.1: `ready()` está tipado con el `Config` ANIDADO de
    // @transistorsoft/background-geolocation-types, pero el runtime (NativeModule.validateConfig) acepta
    // y valida la config PLANA documentada (la misma de v4, la que usamos). Conciliamos el typing roto del
    // SDK con un cast acotado al parámetro real de `ready()`, SIN reescribir una config correcta en runtime.
    const config = {
      desiredAccuracy: DesiredAccuracy.High,
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
      logLevel: LogLevel.Off,
    };
    await bg.ready(config as unknown as Parameters<typeof bg.ready>[0]);
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
      // v5 tipa timestamp como `string | number`; el dominio (y el backend) esperan ISO-8601.
      ts: toIso(location.timestamp),
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

/** Normaliza el timestamp del SDK (v5: `string | number`) a ISO-8601, que es lo que el dominio expone. */
function toIso(timestamp: string | number): string {
  return typeof timestamp === 'string' ? timestamp : new Date(timestamp).toISOString();
}

/**
 * Mapea el `ProviderChangeEvent` nativo al `LocationAvailability` del dominio. `permissionGranted`
 * compara contra el enum tipado `AuthorizationStatus` (NO contra el número crudo): el permiso cuenta
 * como otorgado solo con `Always` o `WhenInUse`; `Denied`/`Restricted`/`NotDetermined` no operan.
 */
function toAvailability(event: ProviderChangeEvent): LocationAvailability {
  return {
    servicesEnabled: event.enabled,
    permissionGranted:
      event.status === AuthorizationStatus.Always ||
      event.status === AuthorizationStatus.WhenInUse,
  };
}

/** Instancia singleton: una sola suscripción nativa multiplexada para toda la app. */
export const backgroundGeolocationSource: LocationSource = new BackgroundGeolocationSource();
