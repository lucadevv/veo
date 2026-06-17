import type {TripResource} from '@veo/api-client';

/**
 * Snapshot LOCAL de viajes del pasajero en MMKV (DIP).
 *
 * IMPORTANTE — esto YA NO es la fuente del HISTORIAL. El historial real (con sus ESTADOS REALES:
 * COMPLETED/CANCELLED/EXPIRED…) lo manda el servidor vía `GET /trips/history` (ver
 * `TripRepository.getTripHistory`). El bug viejo era usar este snapshot como verdad: guardaba la
 * foto del viaje al CREARLO (status REQUESTED) y nunca se actualizaba, así que TODO salía "Solicitado"
 * y al tocar navegaba a la pantalla en vivo legacy.
 *
 * Este snapshot SOBREVIVE con un rol acotado, que el listado del server no cubre:
 *  - DESTINOS RECIENTES del autocompletado (Home / RequestFlow leen `list()` y derivan destinos).
 *  - POLYLINE + coords del mapa del DETALLE: el history item trae `origin`/`destination`, pero no la
 *    `routePolyline`; el detalle la lee de acá cuando existe (degrada elegante si no).
 *
 * NO confiar en el `status` guardado acá para decidir navegación ni para pintar el estado de un viaje:
 * para eso está el server (`getTripHistory` en la lista, `GET /trips/:id` en el detalle).
 */
export interface TripHistoryRepository {
  /** Registra (o actualiza por id) el recurso de viaje devuelto por el bff (alimenta recents + polyline). */
  record(trip: TripResource): void;
  /** Lista los snapshots locales conocidos, del más reciente al más antiguo (recents + lookup por id). */
  list(): TripResource[];
  /** Limpia el snapshot local (p. ej. al cerrar sesión). */
  clear(): void;
}
