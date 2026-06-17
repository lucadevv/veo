import type {GeoPoint} from '@veo/api-client';
import {NotImplementedError} from '../../../core/errors/notImplemented';
import type {
  LocationAvailability,
  LocationProvider,
} from '../domain/locationProvider';

/**
 * Implementación por defecto del puerto de ubicación mientras no exista el módulo nativo.
 *
 * NO es un mock: nunca inventa coordenadas. Falla de forma explícita para que la capa de
 * presentación degrade (p. ej. Home centra el mapa en Lima y pide tocar para fijar puntos).
 * La capa NATIVA sustituye este binding por el provider de GPS real.
 */
export class UnavailableLocationProvider implements LocationProvider {
  getCurrentPosition(): Promise<GeoPoint> {
    return Promise.reject(
      new NotImplementedError('location.getCurrentPosition'),
    );
  }

  watchPosition(_onChange: (point: GeoPoint) => void): () => void {
    // Sin capa nativa no hay stream de posiciones; la baja es un no-op.
    return () => undefined;
  }

  getAvailability(): Promise<LocationAvailability> {
    // Sin capa nativa: estado estable "no disponible" (servicios apagados + permiso negado) para que
    // la UI muestre el estado honesto sin entrar en un bucle de pedir permiso que nunca llegará.
    return Promise.resolve({servicesEnabled: false, permission: 'denied'});
  }

  requestPermission(): Promise<LocationAvailability> {
    return this.getAvailability();
  }

  onAvailabilityChange(
    _listener: (availability: LocationAvailability) => void,
  ): () => void {
    // Sin capa nativa no hay eventos del SO; la baja es un no-op.
    return () => undefined;
  }
}
