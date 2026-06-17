import {NativeModules, Platform} from 'react-native';
import Config from 'react-native-config';
import {z} from 'zod';

/**
 * Configuración de entorno tipada y validada con zod.
 *
 * Resolución de cada URL del backend (de mayor a menor prioridad), igual que la passenger app:
 *  1. `Config.*` (.env vía react-native-config): override EXPLÍCITO del dueño (staging/prod).
 *     EXCEPCIÓN en `__DEV__`: si apunta a una IP LAN privada DISTINTA del host vivo de Metro,
 *     está STALE (el DHCP rotó la IP) → se usa el host de Metro y se avisa por consola.
 *  2. metro-derived (sólo `__DEV__`): el host del packager Metro (la IP ACTUAL de la Mac), así un
 *     device físico llega al `driver-bff` (:4002) sin tocar el .env ni recompilar (un Reload).
 *  3. fallback por plataforma: Android emulador → `10.0.2.2`; iOS/sim → `localhost`.
 *
 * La app SIEMPRE habla con el `driver-bff` (nunca con microservicios directos). La REST
 * vive bajo el prefijo `/api/v1`; el Socket.IO usa el namespace `/driver`.
 */
const isAndroid = Platform.OS === 'android';

/**
 * Deriva el HOST del packager Metro en dev. Lee `getDevServer().url` (soportado en la arquitectura
 * NUEVA/bridgeless, donde `NativeModules.SourceCode.scriptURL` es `null`) y cae a `scriptURL` para la
 * arquitectura vieja. En release / sin packager → `null` (cae al fallback por plataforma).
 */
export function metroDevHost(): string | null {
  const urls: unknown[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const getDevServer = require('react-native/Libraries/Core/Devtools/getDevServer')
      .default as () => {url?: string; bundleLoadedFromServer?: boolean};
    const info = getDevServer();
    // bundleLoadedFromServer:false ⇒ release (bundle embebido) → ignorar el url placeholder.
    if (info.bundleLoadedFromServer !== false) urls.push(info.url);
  } catch {
    // getDevServer no disponible → probamos scriptURL.
  }
  urls.push(
    (NativeModules as {SourceCode?: {scriptURL?: unknown}}).SourceCode?.scriptURL,
  );
  for (const candidate of urls) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    const host = /^https?:\/\/([^/:?#]+)(?::\d+)?/i.exec(candidate)?.[1];
    if (host && host.length > 0) return host;
  }
  return null;
}

/** IP privada RFC 1918 (candidata a quedar STALE cuando el DHCP rota la IP de la Mac). */
function isPrivateLanHost(host: string): boolean {
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  const match = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  return match ? Number(match[1]) >= 16 && Number(match[1]) <= 31 : false;
}

/** Host (IP/hostname) de una URL http(s); `null` si no parsea. */
function hostOf(url: string): string | null {
  return /^https?:\/\/([^/:?#]+)/i.exec(url)?.[1] ?? null;
}

/** Host VIVO del packager Metro en dev (la IP ACTUAL de la Mac); `null` fuera de dev o sin packager. */
const metroHost = __DEV__ ? metroDevHost() : null;

/**
 * Defaults de dev: con host de Metro derivamos del mismo (el driver-bff vive en `:4002`, el
 * tileserver en `:8082`); si no, fallback por plataforma.
 */
const devDefaults = metroHost
  ? {
      bffUrl: `http://${metroHost}:4002/api/v1`,
      wsUrl: `http://${metroHost}:4002`,
      mapStyleUrl: `http://${metroHost}:8082/styles/veo-dark/style.json`,
    }
  : isAndroid
    ? {
        bffUrl: 'http://10.0.2.2:4002/api/v1',
        wsUrl: 'http://10.0.2.2:4002',
        mapStyleUrl: 'http://10.0.2.2:8082/styles/veo-dark/style.json',
      }
    : {
        bffUrl: 'http://localhost:4002/api/v1',
        wsUrl: 'http://localhost:4002',
        mapStyleUrl: 'http://localhost:8082/styles/veo-dark/style.json',
      };

/**
 * Resuelve una URL de backend con AUTO-SANADO de IP stale en dev. Sin override → el `derived`.
 * Con override → gana, SALVO en `__DEV__` que apunte a una IP LAN privada distinta del host vivo de
 * Metro (stale) → se usa el host de Metro. `metroHost` ya es `null` fuera de `__DEV__`, así que
 * staging/prod (dominio) y release jamás entran al if.
 */
function resolveBackendUrl(explicit: string | undefined, derived: string): string {
  if (!explicit) return derived;
  if (metroHost) {
    const host = hostOf(explicit);
    if (host !== null && host !== metroHost && isPrivateLanHost(host)) {
      console.warn(
        `[env] el .env apunta a ${host} pero Metro corre en ${metroHost}: IP LAN stale → uso ` +
          `${metroHost}. Vaciá DRIVER_BFF_URL/DRIVER_BFF_WS_URL en tu .env de dev para no depender de esto.`,
      );
      return derived;
    }
  }
  return explicit;
}

// Canal de soporte por defecto (correo del equipo de soporte al conductor). Configurable por
// entorno vía `SUPPORT_EMAIL` para no hardcodear el contacto en la UI.
const DEFAULT_SUPPORT_EMAIL = 'soporte@veo.pe';

/** URL opcional: acepta una URL válida o cadena vacía (no configurada todavía). */
const optionalUrl = z.union([z.string().url(), z.literal('')]).optional();

const envSchema = z.object({
  /** Entorno de ejecución. */
  APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  /** Base REST del driver-bff, incluye el prefijo `/api/v1`. */
  DRIVER_BFF_URL: z.string().url(),
  /** Origen Socket.IO del driver-bff (sin prefijo REST; el namespace `/driver` se añade aparte). */
  DRIVER_BFF_WS_URL: z.string().url(),
  /** LiveKit (WebRTC publisher); el token lo emite media-service. */
  LIVEKIT_URL: optionalUrl,
  /**
   * Token PÚBLICO de Mapbox (`pk.`). Lo consume `Mapbox.setAccessToken` en el bootstrap nativo.
   * Público por diseño (va al cliente), pero no se commitea: vive en `env/dev.secret.env`.
   * Opcional a nivel de schema para no romper el arranque en tests/builds sin mapa configurado.
   */
  MAPBOX_ACCESS_TOKEN: z.string().optional().default(''),
  /** Estilo/tiles de mapas propios (legado MapLibre). Opcional: con Mapbox el estilo va embebido. */
  MAP_STYLE_URL: optionalUrl,
  /** Correo del canal de soporte al conductor (resuelto desde config, no hardcodeado en la UI). */
  SUPPORT_EMAIL: z.string().email(),
});

export type AppEnv = z.infer<typeof envSchema>;

function loadEnv(): AppEnv {
  const raw = {
    APP_ENV: Config.APP_ENV ?? 'development',
    DRIVER_BFF_URL: resolveBackendUrl(Config.DRIVER_BFF_URL, devDefaults.bffUrl),
    DRIVER_BFF_WS_URL: resolveBackendUrl(
      Config.DRIVER_BFF_WS_URL,
      devDefaults.wsUrl,
    ),
    LIVEKIT_URL: Config.LIVEKIT_URL ?? '',
    MAPBOX_ACCESS_TOKEN: Config.MAPBOX_ACCESS_TOKEN ?? '',
    MAP_STYLE_URL: resolveBackendUrl(Config.MAP_STYLE_URL, devDefaults.mapStyleUrl),
    SUPPORT_EMAIL: Config.SUPPORT_EMAIL || DEFAULT_SUPPORT_EMAIL,
  };

  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(issue => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Configuración de entorno inválida: ${issues}`);
  }
  return parsed.data;
}

/** Configuración resuelta y validada, lista para inyectar en los servicios del core. */
export const env: AppEnv = loadEnv();
