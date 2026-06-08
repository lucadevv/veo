/**
 * @veo/maps
 * Fachada de mapas self-hosted (OSM): routing OSRM/Valhalla + geocoding Nominatim,
 * con motor local propio y caché Redis. Sin Google Maps (soberanía FOUNDATION §0.7).
 *
 * Lo consumen trip-service (cálculo de tarifa BR-T05) y dispatch-service (ETA/scoring BR-T06).
 */
export * from './types.js';
export * from './cache.js';
export * from './polyline.js';
export * from './steps.js';
export * from './local-engine.js';
export * from './local-geocoder.js';
export * from './data/lima-places.js';
export * from './osrm-client.js';
export * from './mapbox-client.js';
export * from './factory.js';
