import type { GeoPoint } from '@veo/api-client';
import BackgroundGeolocation, {
  type AuthorizationStatus,
  type Location,
  type ProviderChangeEvent,
  type Subscription,
} from 'react-native-background-geolocation';
import type {
  LocationAvailability,
  LocationPermission,
  LocationProvider,
} from '../domain/locationProvider';

/**
 * Implementación REAL del puerto de ubicación sobre `react-native-background-geolocation`.
 *
 * Diseño (BR de seguridad: el seguimiento del viaje debe seguir en background):
 *  - `getCurrentPosition`: fix puntual de alta precisión (cotización, pánico).
 *  - `watchPosition`: usa el stream `onLocation` del SDK (no `watchPosition`, que el propio SDK
 *    desaconseja para background) + `start()`, de modo que las posiciones llegan también con la app
 *    en segundo plano hasta donde lo permita la plataforma. Devuelve la función de baja.
 *  - `getAvailability` / `requestPermission` / `onAvailabilityChange`: exponen el estado de permiso +
 *    servicios y los cambios del SO, para que la presentación dé una salida accionable (Ajustes /
 *    reintento) y se RECUPERE sola cuando el usuario prende el GPS o concede el permiso.
 *
 * Nunca inventa coordenadas: si no hay permiso/fix, las promesas rechazan y los hooks degradan.
 */
export class BackgroundGeolocationLocationProvider implements LocationProvider {
  /** `ready` debe ejecutarse una sola vez antes de cualquier API de localización. */
  private readyOnce: Promise<void> | null = null;

  /** Cuántos `watchPosition` activos hay, para arrancar/parar el motor de tracking. */
  private activeWatchers = 0;

  /** Último fix conocido (cacheado por el listener persistente). Se entrega al instante a un watcher nuevo. */
  private lastKnown: GeoPoint | null = null;

  /** Suscriptores a cambios de disponibilidad (GPS on/off, permiso). El handler nativo los notifica. */
  private readonly availabilityListeners = new Set<(availability: LocationAvailability) => void>();

  /** Configura el SDK una única vez (idempotente). */
  private ensureReady(): Promise<void> {
    if (!this.readyOnce) {
      this.readyOnce = BackgroundGeolocation.ready({
        // Precisión máxima durante el viaje (seguridad sobre batería).
        desiredAccuracy: BackgroundGeolocation.DESIRED_ACCURACY_HIGH,
        distanceFilter: 10,
        // El propio SDK gestiona el servicio en primer plano en Android.
        stopOnTerminate: false,
        startOnBoot: false,
        // El arranque del tracking lo controla `watchPosition`, no el SDK.
        autoSync: false,
        // No persistimos ubicaciones en la base interna del SDK (las consume la app).
        persistMode: BackgroundGeolocation.PERSIST_MODE_NONE,
        // Notificación obligatoria del foreground-service en Android.
        notification: {
          title: 'VEO',
          text: 'Seguimiento de seguridad del viaje activo',
        },
      }).then(() => {
        // El SDK emite `location`/`providerchange` (RCTDeviceEventEmitter) también en
        // `getCurrentPosition`, aunque NO haya un `watchPosition` activo. Sin un listener registrado,
        // RN advierte "Sending `location`/`providerchange` with no listeners registered" (benigno
        // pero ruidoso). Registramos listeners PERSISTENTES que CONSUMEN el evento → siempre hay ≥1
        // listener, sin warning. NO arrancan el tracking (eso lo hace `start()` en watchPosition).
        BackgroundGeolocation.onLocation((location) => {
          this.lastKnown = this.toGeoPoint(location);
        });
        // `providerchange` es el evento del SO cuando el usuario prende/apaga el GPS o cambia el
        // permiso desde Ajustes. Lo propagamos a los suscriptores → la app se RECUPERA sola sin poll.
        BackgroundGeolocation.onProviderChange((event) => {
          this.emitAvailability(this.fromProviderEvent(event));
        });
      });
    }
    return this.readyOnce;
  }

  /** Convierte la `Location` del SDK al `GeoPoint` del dominio. */
  private toGeoPoint(location: Location): GeoPoint {
    return { lat: location.coords.latitude, lon: location.coords.longitude };
  }

  /** Traduce el `AuthorizationStatus` numérico del SDK al permiso de dominio. */
  private toPermission(status: AuthorizationStatus): LocationPermission {
    switch (status) {
      case BackgroundGeolocation.AUTHORIZATION_STATUS_ALWAYS:
      case BackgroundGeolocation.AUTHORIZATION_STATUS_WHEN_IN_USE:
        return 'granted';
      case BackgroundGeolocation.AUTHORIZATION_STATUS_DENIED:
        return 'denied';
      case BackgroundGeolocation.AUTHORIZATION_STATUS_RESTRICTED:
        return 'restricted';
      // AUTHORIZATION_STATUS_NOT_DETERMINED (iOS) y cualquier valor futuro → aún sin decidir.
      default:
        return 'undetermined';
    }
  }

  /** Mapea el `ProviderChangeEvent`/`ProviderState` del SDK a la disponibilidad de dominio. */
  private fromProviderEvent(event: ProviderChangeEvent): LocationAvailability {
    return {
      servicesEnabled: event.enabled,
      permission: this.toPermission(event.status),
    };
  }

  /** Notifica a todos los suscriptores de disponibilidad (defensivo: un listener que tira no tumba al resto). */
  private emitAvailability(availability: LocationAvailability): void {
    this.availabilityListeners.forEach((listener) => {
      try {
        listener(availability);
      } catch {
        // Un suscriptor defectuoso no debe romper la cadena de notificación.
      }
    });
  }

  async getCurrentPosition(): Promise<GeoPoint> {
    await this.ensureReady();
    const location = await BackgroundGeolocation.getCurrentPosition({
      samples: 2,
      timeout: 15,
      maximumAge: 5000,
      desiredAccuracy: BackgroundGeolocation.DESIRED_ACCURACY_HIGH,
    });
    return this.toGeoPoint(location);
  }

  async getAvailability(): Promise<LocationAvailability> {
    await this.ensureReady();
    const state = await BackgroundGeolocation.getProviderState();
    return this.fromProviderEvent(state);
  }

  async requestPermission(): Promise<LocationAvailability> {
    await this.ensureReady();
    try {
      // Dispara el prompt del SO si el permiso está sin determinar. Si ya estaba `denied`, el SO no
      // muestra nada y resuelve/rechaza con el estado actual; en ambos casos leemos el estado real.
      await BackgroundGeolocation.requestPermission();
    } catch {
      // `requestPermission` RECHAZA con el status cuando el usuario niega: no es un error de programa,
      // el estado real se lee a continuación con `getAvailability`.
    }
    return this.getAvailability();
  }

  onAvailabilityChange(listener: (availability: LocationAvailability) => void): () => void {
    this.availabilityListeners.add(listener);
    // Asegura que el handler nativo `onProviderChange` esté registrado (idempotente).
    void this.ensureReady();
    return () => {
      this.availabilityListeners.delete(listener);
    };
  }

  watchPosition(onChange: (point: GeoPoint) => void): () => void {
    let subscription: Subscription | null = null;
    let cancelled = false;

    void this.ensureReady().then(() => {
      if (cancelled) {
        return;
      }
      subscription = BackgroundGeolocation.onLocation((location) => {
        onChange(this.toGeoPoint(location));
      });
      // Entrega inmediata del último fix conocido (si lo hay) para no esperar al primer evento.
      if (this.lastKnown) {
        onChange(this.lastKnown);
      }
      this.activeWatchers += 1;
      if (this.activeWatchers === 1) {
        // Arranca el motor de tracking (foreground-service en Android) al primer watcher.
        void BackgroundGeolocation.start();
      }
    });

    return () => {
      if (cancelled) {
        return;
      }
      cancelled = true;
      if (subscription) {
        subscription.remove();
        subscription = null;
        this.activeWatchers = Math.max(0, this.activeWatchers - 1);
        if (this.activeWatchers === 0) {
          // Sin watchers activos detenemos el tracking para no consumir batería.
          void BackgroundGeolocation.stop();
        }
      }
    };
  }
}
