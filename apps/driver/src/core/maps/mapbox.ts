import Mapbox from '@rnmapbox/maps';
import { env } from '../config/env';

/**
 * Bootstrap nativo de Mapbox (Lote 0+1: migración a `@rnmapbox/maps`).
 *
 * `Mapbox.setAccessToken` registra el token PÚBLICO (`pk.`) que el SDK nativo usa para descargar
 * teselas/glyphs/sprites en runtime. Debe ejecutarse UNA sola vez, a nivel de módulo y ANTES de
 * montar cualquier `MapView` (por eso se llama desde `index.js`, fuera de React).
 *
 * Si el token no está configurado (tests, builds sin `.env`), no llamamos a `setAccessToken`. OJO: en
 * `@rnmapbox/maps` v10 montar un `MapView` SIN token registrado CRASHEA el proceso nativo — por eso el
 * fail-safe vive en `AppMap` (degrada a un lienzo oscuro cuando `MAPBOX_ACCESS_TOKEN` está vacío) y la
 * app NO se cierra. Acá solo evitamos setear un token vacío. No se loguea el token.
 */
export function initMapbox(): void {
  const token = env.MAPBOX_ACCESS_TOKEN;
  if (!token) {
    return;
  }
  // `setAccessToken` devuelve una promesa; el arranque no debe bloquearse esperándola.
  void Mapbox.setAccessToken(token);
}
