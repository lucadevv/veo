import { config as loadEnvFile } from 'dotenv';

// Carga el env del tier apuntado por ENVFILE (estilo dart-define-from-file, igual que passenger/driver).
// Default development. DEBE correr ANTES de leer process.env.* (la CSP de abajo y el inlining de
// NEXT_PUBLIC_* dependen de que ya estén cargadas). Sin .env generado ni script de merge.
loadEnvFile({ path: process.env.ENVFILE ?? 'env/development.env' });

/**
 * Configuración Next.js para family-web (página pública del seguimiento familiar).
 * Soberanía: la CSP solo habilita orígenes self-hosted declarados por env (tiles OSM,
 * BFF público y LiveKit). No se permite ningún SaaS de terceros.
 */

/** Devuelve el origin de una URL o null si no es válida. */
function originOf(value) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** Genera el origen y sus variantes ws/wss para Socket.IO y WebRTC (LiveKit). */
function wsVariants(origin) {
  if (!origin) return [];
  if (origin.startsWith('http://')) return [origin, origin.replace('http://', 'ws://')];
  if (origin.startsWith('https://')) return [origin, origin.replace('https://', 'wss://')];
  return [origin];
}

const bffHttpOrigin = originOf(process.env.NEXT_PUBLIC_BFF_URL) ?? 'http://localhost:4001';
const bffWsOrigin = originOf(process.env.NEXT_PUBLIC_BFF_WS_URL) ?? bffHttpOrigin;
const tileOrigin = originOf(process.env.NEXT_PUBLIC_TILE_URL);
const livekitOrigin = originOf(process.env.NEXT_PUBLIC_LIVEKIT_URL);

const connectSrc = new Set(["'self'", ...wsVariants(bffHttpOrigin), ...wsVariants(bffWsOrigin)]);
if (tileOrigin) connectSrc.add(tileOrigin);
for (const variant of wsVariants(livekitOrigin)) connectSrc.add(variant);

const imgSrc = new Set(["'self'", 'data:', 'blob:']);
if (tileOrigin) imgSrc.add(tileOrigin);

const mediaSrc = new Set(["'self'", 'blob:']);
for (const variant of wsVariants(livekitOrigin)) mediaSrc.add(variant);

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  // El App Router de Next inyecta scripts de bootstrap/hidratación en línea.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  `img-src ${[...imgSrc].join(' ')}`,
  // MapLibre y LiveKit crean workers desde blobs.
  "worker-src 'self' blob:",
  `connect-src ${[...connectSrc].join(' ')}`,
  `media-src ${[...mediaSrc].join(' ')}`,
  'upgrade-insecure-requests',
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@veo/shared-types', '@veo/api-client', '@veo/utils'],
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
  // Los paquetes @veo/* están escritos en TS con extensiones .js explícitas (NodeNext).
  // Webpack necesita mapear esos imports .js a sus fuentes .ts.
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
        { key: 'Content-Security-Policy', value: contentSecurityPolicy },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        { key: 'X-DNS-Prefetch-Control', value: 'off' },
      ],
    },
  ],
};

export default nextConfig;
