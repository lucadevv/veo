import {useEffect, useState} from 'react';
import type {LocationAvailability} from '../../domain/location-source';
import {useLocationSource} from '../providers/LocationSourceProvider';

/**
 * Observa la DISPONIBILIDAD del GPS del dispositivo (servicios del SO + permiso de la app) a través
 * del puerto `LocationSource`. Devuelve `null` mientras no hay GPS nativo o aún no llegó el primer
 * estado; un objeto `LocationAvailability` en cuanto el adapter reporta.
 *
 * La UI del turno lo usa para AVISAR cuando el conductor está en turno pero apagó la ubicación o no
 * dio permiso: sin esto, el conductor cree que está visible para el dispatch cuando en realidad no
 * emite su posición (gap operativo silencioso).
 */
export function useLocationAvailability(): LocationAvailability | null {
  const source = useLocationSource();
  const [availability, setAvailability] = useState<LocationAvailability | null>(null);

  useEffect(() => {
    if (!source.available) {
      setAvailability(null);
      return;
    }
    const unsubscribe = source.onAvailabilityChange(setAvailability);
    return unsubscribe;
  }, [source]);

  return availability;
}
