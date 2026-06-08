import {useEffect, useState} from 'react';
import type {GeoPoint} from '@veo/api-client';
import {useLocationSource} from '../../../realtime/presentation/providers/LocationSourceProvider';

/**
 * Ubicación en vivo del conductor para PINTAR el mapa (sólo presentación). Se suscribe a la fuente
 * de GPS nativa (`LocationSource`) y devuelve la última muestra como `GeoPoint`. Si la oleada nativa
 * aún no instaló una fuente real (`available === false`), devuelve `null`: el mapa degrada con
 * elegancia (sin pin del conductor) y NO se inventan coordenadas. No altera lógica de viaje alguna.
 */
export function useDriverLocation(): GeoPoint | null {
  const source = useLocationSource();
  const [point, setPoint] = useState<GeoPoint | null>(null);

  useEffect(() => {
    if (!source.available) {
      setPoint(null);
      return;
    }
    const unsubscribe = source.subscribe(sample => {
      setPoint({lat: sample.lat, lon: sample.lon});
    });
    return unsubscribe;
  }, [source]);

  return point;
}
