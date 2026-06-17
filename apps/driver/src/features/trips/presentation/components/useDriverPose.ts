import { useEffect, useState } from 'react';
import type { GeoPoint } from '@veo/api-client';
import { useLocationSource } from '../../../realtime/presentation/providers/LocationSourceProvider';

/** Pose del conductor para la cámara de navegación: ubicación + rumbo (heading-up). */
export interface DriverPose {
  /** Última posición conocida. */
  point: GeoPoint;
  /** Rumbo en grados (0=N, 90=E) o `null` si el GPS no lo provee (la cámara cae a 0 = norte arriba). */
  heading: number | null;
}

/**
 * Pose en vivo del conductor (ubicación + heading) para la cámara de NAVEGACIÓN tipo Waze. Espejo de
 * `useDriverLocation` pero conservando el `heading` de la muestra de GPS (que `useDriverLocation`
 * descarta, porque solo pinta el pin). Si la fuente de GPS no está disponible (`available === false`,
 * p. ej. sin la oleada nativa o en simulador sin fuente dev) devuelve `null`: el mapa degrada al
 * encuadre normal, sin inventar coordenadas (degradación honesta). Solo presentación.
 */
export function useDriverPose(): DriverPose | null {
  const source = useLocationSource();
  const [pose, setPose] = useState<DriverPose | null>(null);

  useEffect(() => {
    if (!source.available) {
      setPose(null);
      return;
    }
    const unsubscribe = source.subscribe((sample) => {
      setPose({ point: { lat: sample.lat, lon: sample.lon }, heading: sample.heading ?? null });
    });
    return unsubscribe;
  }, [source]);

  return pose;
}
