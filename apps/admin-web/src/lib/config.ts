/**
 * Configuración pública (cliente). Solo variables NEXT_PUBLIC_* (inlinadas en build).
 * El token de sesión NUNCA vive aquí: las llamadas a datos van por /api/bff (mismo origen).
 */

/** Base del proxy server-side; el navegador nunca habla directo con el bff. */
export const BFF_PROXY_BASE = '/api/bff';

/** URL del style.json del tileserver OSM self-hosted (puede faltar → fallback soberano). */
export const TILE_URL = process.env.NEXT_PUBLIC_TILE_URL ?? '';

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
