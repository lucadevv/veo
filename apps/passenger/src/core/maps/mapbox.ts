import Mapbox from '@rnmapbox/maps';
import {env} from '../config/env';

/**
 * Bootstrap nativo de Mapbox (Lote 4: migración del pasajero a `@rnmapbox/maps`, gemelo del
 * conductor).
 *
 * `Mapbox.setAccessToken` registra el token PÚBLICO (`pk.`) que el SDK nativo usa para descargar
 * teselas/glyphs/sprites en runtime. Debe ejecutarse UNA sola vez, a nivel de módulo y ANTES de
 * montar cualquier `MapView` (por eso se llama desde el bootstrap nativo, fuera de React).
 *
 * Si el token no está configurado (tests, builds sin `.env`), no llamamos a `setAccessToken`: el
 * mapa simplemente no cargará teselas, pero la app arranca sin romper. No se loguea el token.
 */
export function initMapbox(): void {
  const token = env.mapboxAccessToken;
  if (!token) {
    return;
  }
  // `setAccessToken` devuelve una promesa; el arranque no debe bloquearse esperándola.
  void Mapbox.setAccessToken(token);
}
