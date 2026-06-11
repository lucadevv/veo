import { LocalMapsEngine, type LocalMapsEngineOptions } from './local-engine.js';
import { OsrmMapsClient, type OsrmMapsClientOptions } from './osrm-client.js';
import { MapboxMapsClient, type MapboxMapsClientOptions } from './mapbox-client.js';
import type { MapsClient } from './types.js';

/**
 * Modos de mapas soportados. FUENTE DE VERDAD ÚNICA: los env schemas de los servicios derivan su
 * `z.enum(MAPS_MODES)` de aquí (no duplican la lista a mano), así no vuelve a haber drift de contrato
 * —que dejó a trip/dispatch/driver-bff sin `mapbox` mientras public-bff sí lo tenía—.
 */
export const MAPS_MODES = ['osrm', 'local', 'mapbox'] as const;

export type MapsMode = (typeof MAPS_MODES)[number];

export interface CreateMapsClientOptions {
  mode: MapsMode;
  osrm?: OsrmMapsClientOptions;
  local?: LocalMapsEngineOptions;
  mapbox?: MapboxMapsClientOptions;
}

/**
 * Selecciona el cliente de mapas según el modo (env `VEO_MAPS_MODE`).
 * - `osrm`: infraestructura OSM self-hosted.
 * - `mapbox`: APIs HTTP de Mapbox (token público `pk`, server-side, sin SDK).
 * - `local`: motor propio de estimación (dev/CI sin red, o fallback).
 */
export function createMapsClient(opts: CreateMapsClientOptions): MapsClient {
  if (opts.mode === 'osrm') {
    if (!opts.osrm) throw new Error('createMapsClient: mode "osrm" requiere opciones osrm');
    return new OsrmMapsClient(opts.osrm);
  }
  if (opts.mode === 'mapbox') {
    if (!opts.mapbox) throw new Error('createMapsClient: mode "mapbox" requiere opciones mapbox');
    return new MapboxMapsClient(opts.mapbox);
  }
  return new LocalMapsEngine(opts.local);
}
