/**
 * Entorno público (inlined por Next en el bundle del cliente).
 * Las referencias a process.env.NEXT_PUBLIC_* deben ser literales para que Next las sustituya.
 * No contiene secretos: solo URLs de servicios self-hosted.
 */

const DEFAULT_BFF_URL = 'http://localhost:4001/api/v1';

export const publicEnv = {
  /** Base REST del public-bff usada desde el cliente (React Query). */
  bffUrl: process.env.NEXT_PUBLIC_BFF_URL ?? DEFAULT_BFF_URL,
  /** Origen del gateway Socket.IO del public-bff (namespace /family). */
  bffWsUrl: process.env.NEXT_PUBLIC_BFF_WS_URL ?? 'http://localhost:4001',
  /** Plantilla de tiles XYZ o style.json OSM self-hosted. Vacío = mapa no disponible. */
  tileUrl: process.env.NEXT_PUBLIC_TILE_URL ?? '',
  /** URL wss del servidor LiveKit self-hosted. Vacío = video deshabilitado. */
  livekitUrl: process.env.NEXT_PUBLIC_LIVEKIT_URL ?? '',
  /** Teléfono del botón de ayuda. Default 105 (Policía Nacional del Perú). */
  helpPhone: process.env.NEXT_PUBLIC_HELP_PHONE ?? '105',
} as const;
