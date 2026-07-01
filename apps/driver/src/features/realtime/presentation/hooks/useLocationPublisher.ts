import { useEffect } from 'react';
import type { DriverLocationReport } from '@veo/api-client';
import type { DriverSocket } from '../../../../core/realtime/socket';
import type { LocationSample } from '../../domain/location-source';
import { currentVehicleType } from '../../../shift/presentation/state/vehicleTypeStore';
import { useLocationSource } from '../providers/LocationSourceProvider';

/**
 * Cada cuánto RE-PUBLICAR la última ubicación conocida aunque el conductor esté QUIETO (heartbeat de
 * presencia). Debe ser MENOR que el TTL del `driver:loc` del hot-index de dispatch
 * (`DRIVER_LOC_TTL_SECONDS`, hoy 60s): `background-geolocation` solo emite una muestra al moverse
 * `distanceFilter` (10 m), así que un conductor esperando un viaje QUIETO dejaría de publicar y su
 * presencia expiraría → saldría del pool y ni el dispatch ni el admin lo verían. 20s → 3 latidos por
 * ventana de TTL (margen ante un latido perdido por un corte breve del socket).
 */
const HEARTBEAT_MS = 20_000;

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
 *
 * PRESENCIA (heartbeat): además de emitir en cada muestra real de GPS, re-publica la ÚLTIMA ubicación
 * conocida cada `HEARTBEAT_MS` con timestamp ACTUAL. Sin esto, un conductor QUIETO (el caso normal:
 * esperando un viaje) desaparece del pool cuando su `driver:loc` expira. NO inventa posición: si aún no
 * hubo ninguna muestra real, el heartbeat no emite. (En background prolongado el SO puede pausar el
 * timer JS; la presencia en background es un follow-up con el heartbeat NATIVO de la librería.)
 */
export function useLocationPublisher(socket: DriverSocket | null, enabled: boolean): void {
  const source = useLocationSource();

  useEffect(() => {
    if (!socket || !enabled || !source.available) {
      return;
    }

    // Última muestra real conocida; el heartbeat la reusa (con ts fresco) cuando el GPS deja de emitir.
    let last: LocationSample | null = null;

    // ¿El GPS sigue VIVO (servicios del SO + permiso)? Un conductor QUIETO con GPS ok debe seguir
    // presente vía heartbeat; pero si revoca el permiso o apaga la ubicación mid-turno, el heartbeat NO
    // debe re-publicar: emitir la última posición con ts fresco haría que dispatch/ops lo vean "vivo y
    // quieto" en una posición FANTASMA y le sigan ofreciendo viajes. Sin señal viva → dejamos expirar su
    // `driver:loc` (sale del pool, que es lo correcto: ya no se lo puede ubicar). No usamos la edad de
    // `last` como señal: un conductor legítimamente quieto también tiene un `last` que envejece — el
    // único indicador fiable de "GPS muerto" vs "quieto" es la DISPONIBILIDAD. Arranca en `true`: el
    // heartbeat igual no emite hasta tener un `last` real (que solo existe si el GPS emitió alguna vez).
    let gpsLive = true;

    const publish = (sample: LocationSample): void => {
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
    };

    const unsubscribe = source.subscribe((sample) => {
      last = sample;
      publish(sample);
    });

    // El SO avisa cuando cambia la disponibilidad (permiso revocado / servicios apagados). El heartbeat
    // lee este flag para NO emitir presencia fantasma cuando el GPS ya no está vivo.
    const unsubscribeAvailability = source.onAvailabilityChange((availability) => {
      gpsLive = availability.servicesEnabled && availability.permissionGranted;
    });

    // Heartbeat de presencia: el conductor SIGUE ahí (solo que quieto) → re-publicamos su última
    // ubicación con timestamp ACTUAL para refrescar su `driver:loc` en el dispatch antes del TTL. SOLO si
    // el GPS sigue vivo (`gpsLive`): sin señal, dejamos expirar la presencia en vez de mentir posición.
    const heartbeat = setInterval(() => {
      if (last && gpsLive) {
        publish({ ...last, ts: new Date().toISOString() });
      }
    }, HEARTBEAT_MS);

    return () => {
      clearInterval(heartbeat);
      unsubscribe();
      unsubscribeAvailability();
    };
  }, [socket, enabled, source]);
}
