import { LocalMapsEngine, type LocalMapsEngineOptions } from './local-engine.js';
import { OsrmMapsClient, type OsrmMapsClientOptions } from './osrm-client.js';
import { MapboxMapsClient, type MapboxMapsClientOptions } from './mapbox-client.js';
import type { MapsClient } from './types.js';

export type MapsMode = 'osrm' | 'local' | 'mapbox';

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
