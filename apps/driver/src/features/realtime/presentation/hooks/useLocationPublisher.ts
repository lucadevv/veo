import {useEffect} from 'react';
import type {DriverLocationReport} from '@veo/api-client';
import type {DriverSocket} from '../../../../core/realtime/socket';
import {currentVehicleType} from '../../../shift/presentation/state/vehicleTypeStore';
import {useLocationSource} from '../providers/LocationSourceProvider';

/**
 * Publica el GPS del conductor por el socket `/driver` (evento `location`).
 *
 * El canal de ENVÍO queda completamente cableado aquí: toma muestras de la `LocationSource` (puerto
 * nativo) y las emite con ack. Mientras la oleada nativa no instale una fuente real
 * (`source.available === false`), el hook no hace nada (no inventa ubicaciones).
 *
 * Cada reporte sella el `vehicleType` ACTIVO del conductor (Auto | Moto). El dispatch usa ese campo
 * para indexar al conductor y ofrecerle viajes MOTO solo a motos. Se lee con `getState()` en cada
 * muestra (no en el arranque), así un cambio de tipo durante el turno aplica al siguiente reporte
 * sin re-suscribir la fuente de GPS.
 */
export function useLocationPublisher(socket: DriverSocket | null, enabled: boolean): void {
  const source = useLocationSource();

  useEffect(() => {
    if (!socket || !enabled || !source.available) {
      return;
    }
    const unsubscribe = source.subscribe(sample => {
      const report: DriverLocationReport = {
        lat: sample.lat,
        lon: sample.lon,
        heading: sample.heading ?? null,
        speed: sample.speed ?? null,
        accuracy: sample.accuracy ?? null,
        ts: sample.ts,
        vehicleType: currentVehicleType(),
      };
      socket.emit('location', report, () => undefined);
    });
    return unsubscribe;
  }, [socket, enabled, source]);
}
