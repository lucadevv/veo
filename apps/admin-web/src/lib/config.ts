/**
 * Configuración pública (cliente). Solo variables NEXT_PUBLIC_* (inlinadas en build).
 * El token de sesión NUNCA vive aquí: las llamadas a datos van por /api/bff (mismo origen).
 */

/** Base del proxy server-side; el navegador nunca habla directo con el bff. */
export const BFF_PROXY_BASE = '/api/bff';

/**
 * Token público de Mapbox (pk.*) para el mapa de operación (/ops). El mapa usa el estilo veo-dark
 * "Midnight Motion" (Mapbox Streets v8), consistente con las apps passenger/driver. El token es
 * público por diseño (se restringe por URL en el dashboard de Mapbox); puede faltar → fallback
 * soberano (fondo sólido, los marcadores en vivo siguen funcionando).
 */
export const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';

/** Origen para Socket.IO (/ops). Si falta, se usa el mismo origen del navegador. */
export const BFF_WS_URL = process.env.NEXT_PUBLIC_BFF_WS_URL ?? '';

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Centro/zoom inicial del mapa (Lima por defecto). */
export const MAP_DEFAULTS = {
  lon: num(process.env.NEXT_PUBLIC_MAP_CENTER_LON, -77.0428),
  lat: num(process.env.NEXT_PUBLIC_MAP_CENTER_LAT, -12.0464),
  zoom: num(process.env.NEXT_PUBLIC_MAP_ZOOM, 11),
} as const;
