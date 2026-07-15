import { config as loadEnvFile } from 'dotenv';

// Carga el env del tier apuntado por ENVFILE (estilo dart-define-from-file, igual que passenger/driver).
// Default development. DEBE correr ANTES de leer process.env.* (la CSP de abajo y el inlining de
// NEXT_PUBLIC_* dependen de que ya estén cargadas). Sin .env generado ni script de merge.
loadEnvFile({ path: process.env.ENVFILE ?? 'env/development.env' });

/**
 * Configuración de admin-web (Next.js 14 App Router).
 * Cabeceras de seguridad estrictas con CSP que permite el websocket del admin-bff (soberano) y los
 * orígenes de Mapbox (proveedor del mapa base del proyecto: tiles + glyphs + telemetría). El mapa
 * base (calles) NO es dato sensible; soberanía = biometría/video/pánico/audit/PII (esos van por el bff).
 */

/**
 * Orígenes de Mapbox (mapa base veo-dark "Midnight Motion", consistente con passenger/driver).
 *  - api.mapbox.com      : TileJSON (estilo/source) + glyphs (fuentes).
 *  - *.tiles.mapbox.com  : los TILES vectoriales (.vector.pbf). El TileJSON de api.mapbox.com los sirve
 *                          desde a./b.tiles.mapbox.com — SIN este origen, la CSP bloquea los .pbf y el
 *                          mapa degrada (TileJSON 200 pero 0 tiles). Verificado con chrome-devtools.
 *  - events.mapbox.com   : telemetría/eventos del SDK (POST).
 * Always-on (dev y prod): Mapbox es el proveedor del mapa para todo el proyecto.
 */
const MAPBOX_ORIGINS = [
  'https://api.mapbox.com',
  'https://*.tiles.mapbox.com',
  'https://events.mapbox.com',
];

/** Extrae el origen (scheme://host:port) de una URL de entorno, o null si no es válida. */
function originOf(url) {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Convierte un origen http(s) en su equivalente ws(s) para connect-src. */
function wsOriginOf(httpOrigin) {
  if (!httpOrigin) return null;
  return httpOrigin.replace(/^http/, 'ws');
}

const isDev = process.env.NODE_ENV !== 'production';

const bffOrigin = originOf(process.env.NEXT_PUBLIC_BFF_URL);
const wsOrigin = originOf(process.env.NEXT_PUBLIC_BFF_WS_URL);
// Origen del storage de media (imágenes de documentos firmadas/presigned). Env-driven para soportar
// AMBOS entornos sin hardcodear: dev = http://localhost:9002 (MinIO local), prod/VPS = el dominio S3/CDN.
// Sin esto en img-src, el browser BLOQUEA la imagen del documento aunque la URL responda 200.
const mediaOrigin = originOf(process.env.NEXT_PUBLIC_MEDIA_URL);

const connectSrc = [
  "'self'",
  ...MAPBOX_ORIGINS,
  bffOrigin,
  wsOrigin,
  wsOriginOf(wsOrigin),
  wsOriginOf(bffOrigin),
].filter(Boolean);

const imgSrc = ["'self'", 'data:', 'blob:', ...MAPBOX_ORIGINS, mediaOrigin].filter(Boolean);
const mediaSrc = ["'self'", 'blob:', bffOrigin].filter(Boolean);

// En dev Next requiere 'unsafe-eval'; en prod se omite. 'unsafe-inline' es necesario para
// los estilos de MapLibre/Next; los scripts inline de Next 14 (App Router) usan hashes propios.
const scriptSrc = ["'self'", "'unsafe-inline'", isDev ? "'unsafe-eval'" : null].filter(Boolean);

const csp = [
  `default-src 'self'`,
  `script-src ${scriptSrc.join(' ')}`,
  `style-src 'self' 'unsafe-inline'`,
  `img-src ${imgSrc.join(' ')}`,
  `media-src ${mediaSrc.join(' ')}`,
  `font-src 'self' data:`,
  `connect-src ${connectSrc.join(' ')}`,
  `worker-src 'self' blob:`,
  `frame-ancestors 'none'`,
  `base-uri 'self'`,
  `form-action 'self'`,
  `object-src 'none'`,
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@veo/shared-types', '@veo/api-client', '@veo/utils', '@veo/policy'],
  experimental: {
    optimizePackageImports: ['lucide-react', 'date-fns'],
  },
  // Los paquetes @veo/* en TS usan especificadores ESM con extensión `.js`; webpack debe
  // mapearlos a sus fuentes `.ts` (igual que hace tsc con moduleResolution NodeNext).
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
  headers: async () => [
    {
      source: '/(.*)',
      headers: [
        { key: 'Content-Security-Policy', value: csp },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        // Cámara permitida en el propio origen para reproducir video con watermark; el resto bloqueado.
        { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
      ],
    },
  ],
};

export default nextConfig;
