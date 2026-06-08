import {useEffect} from 'react';
import {PUBLISHER_TOKEN_UNAVAILABLE} from '../../domain/ports/trip-media-publisher';
import {useTripMediaPublisher} from '../providers/TripMediaPublisherProvider';

/**
 * Controla el publisher de video del habitáculo durante el viaje activo: inicia la publicación a la
 * sala `trip:<tripId>` cuando `active` es true y la detiene al salir.
 *
 * Si el backend aún no expone el token de publisher (hueco conocido), `start` rechaza con
 * `PUBLISHER_TOKEN_UNAVAILABLE`: lo registramos en dev pero NO interrumpimos la pantalla del viaje
 * (la seguridad del publisher es un canal aparte). No se inventan credenciales.
 */
export function useTripPublisher(tripId: string, active: boolean): void {
  const publisher = useTripMediaPublisher();

  useEffect(() => {
    if (!active) {
      return;
    }
    publisher.start(tripId).catch((error: unknown) => {
      const code = error instanceof Error ? (error as {code?: string}).code : undefined;
      if (__DEV__ && code !== PUBLISHER_TOKEN_UNAVAILABLE) {
        console.warn('[VEO] Publisher de viaje no pudo iniciar:', error);
      }
    });
    return () => {
      publisher.stop().catch(() => undefined);
    };
  }, [tripId, active, publisher]);
}
