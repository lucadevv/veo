/**
 * Configuración de admin-web (Next.js 14 App Router).
 * Cabeceras de seguridad estrictas con CSP que permite SOLO orígenes soberanos:
 * el tileserver self-hosted (OSM) y el websocket del admin-bff. Nada de SaaS de terceros.
 */

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

const tileOrigin = originOf(process.env.NEXT_PUBLIC_TILE_URL);
const bffOrigin = originOf(process.env.NEXT_PUBLIC_BFF_URL);
const wsOrigin = originOf(process.env.NEXT_PUBLIC_BFF_WS_URL);

const connectSrc = [
  "'self'",
  tileOrigin,
  bffOrigin,
  wsOrigin,
  wsOriginOf(wsOrigin),
  wsOriginOf(bffOrigin),
].filter(Boolean);

const imgSrc = ["'self'", 'data:', 'blob:', tileOrigin].filter(Boolean);
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
  transpilePackages: ['@veo/shared-types', '@veo/api-client', '@veo/utils'],
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
