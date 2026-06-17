import {NativeModules, Platform} from 'react-native';
import Config from 'react-native-config';
import {z} from 'zod';

/**
 * Configuración de entorno tipada y validada con zod (react-native-config).
 *
 * El pasajero SIEMPRE habla con el `public-bff` (nunca con microservicios directos):
 *  - REST   → `PUBLIC_BFF_URL`    (incluye el prefijo `/api/v1`).
 *  - Socket → `PUBLIC_BFF_WS_URL` (host del BFF; el namespace `/passenger` lo añade el cliente socket).
 *
 * ─── Orden de resolución de cada URL (de mayor a menor prioridad) ───────────────
 *  1. `Config.PUBLIC_*` (.env vía react-native-config): override EXPLÍCITO del dueño.
 *     Es la fuente de verdad para staging/prod y para cualquier override manual en dev.
 *     Si está seteado, GANA siempre → staging/prod nunca se ven afectados por lo de abajo.
 *     EXCEPCIÓN sólo en `__DEV__` (auto-sanado anti-IP-stale): si el override apunta a una IP
 *     LAN privada (RFC 1918) DISTINTA del host vivo de Metro, está STALE (el DHCP rotó la IP de
 *     la Mac) → se prefiere el host de Metro y se avisa por consola. Así un Reload reconecta sin
 *     recompilar ni vaciar el `.env`. URLs con dominio (staging/prod) y release nunca se tocan.
 *  2. metro-derived (sólo `__DEV__`): si hay un host de Metro (device físico hablando con
 *     el packager en la IP de la Mac, ej. `http://192.168.18.227:8081/...`), derivamos las
 *     URLs del backend de ESA misma IP. Así el device llega al backend sin tocar el .env ni
 *     recompilar: basta un Reload de Metro. Ver `metroDevHost()`.
 *  3. fallback localhost/10.0.2.2: sin Metro host (emulador Android usa `10.0.2.2`, que no
 *     resuelve `localhost`; iOS/sim usan `localhost`).
 *
 * IMPORTANTE — convención de envs del dueño: el `.env` sigue siendo la fuente para
 * overrides explícitos (incluido el token Mapbox secreto, que NO se toca acá). Esto SÓLO
 * mejora el DEFAULT de dev cuando no hay override; no cambia la precedencia ni los secretos.
 */

/**
 * Deriva el HOST (IP/hostname) del packager Metro en dev.
 *
 * Lee el URL del packager de DOS fuentes, en orden de preferencia:
 *  1. `getDevServer().url` — API soportada en la **arquitectura nueva (bridgeless)**, donde
 *     `NativeModules.SourceCode.scriptURL` devuelve `null`. Ej. `"http://localhost:8081/"`
 *     (simulador) o `"http://192.168.18.238:8081/"` (device físico). `bundleLoadedFromServer:false`
 *     ⇒ release con bundle embebido → se ignora.
 *  2. `NativeModules.SourceCode.scriptURL` — fallback para la **arquitectura vieja (puente)**.
 *     Ej. `"http://192.168.18.238:8081/index.bundle?platform=ios&dev=true"`.
 *
 * Devuelve el primer host http(s) válido. En release / sin packager (file://, vacío, error)
 * → `null`, para caer en el fallback localhost/10.0.2.2.
 *
 * Histórico: antes leía SÓLO `scriptURL`; con `RCTNewArchEnabled=true` eso es `null`, así que el
 * auto-derive nunca disparaba y un `.env` con IP LAN stale ganaba → "sin conexión". `getDevServer()`
 * lo arregla porque funciona en ambas arquitecturas.
 */
export function metroDevHost(): string | null {
  const urls: unknown[] = [];
  try {
    // getDevServer es un módulo INTERNO de RN expuesto solo como CommonJS (no hay import ESM) y solo
    // existe en dev (por eso el try/catch). El require dinámico es deliberado, no un workaround.
    const getDevServer =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('react-native/Libraries/Core/Devtools/getDevServer')
        .default as () => {url?: string; bundleLoadedFromServer?: boolean};
    const info = getDevServer();
    // En release getDevServer devuelve un url placeholder con bundleLoadedFromServer:false.
    if (info.bundleLoadedFromServer !== false) urls.push(info.url);
  } catch {
    // getDevServer no disponible en este runtime → probamos scriptURL.
  }
  urls.push(
    (NativeModules as {SourceCode?: {scriptURL?: unknown}}).SourceCode
      ?.scriptURL,
  );

  for (const candidate of urls) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    // Sólo packager http(s); file:// (release) y otros esquemas → siguiente candidato.
    const host = /^https?:\/\/([^/:?#]+)(?::\d+)?/i.exec(candidate)?.[1];
    if (host && host.length > 0) return host;
  }
  return null;
}

/**
 * Rango de IP privada (RFC 1918): un host de LAN local, el candidato típico a quedar STALE
 * cuando el DHCP rota la IP de la Mac. `10/8` · `172.16/12` · `192.168/16`.
 */
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
 * Resuelve una URL de backend con AUTO-SANADO de IP stale en dev (prioridad 1 del header).
 * Sin override → el `derived` (metro/fallback). Con override → gana, SALVO el caso stale en
 * `__DEV__`: override a una IP LAN privada distinta del host vivo de Metro → se usa el host de
 * Metro (un Reload reconecta sin recompilar). Se avisa por consola para que no sea magia silenciosa.
 * `metroHost` ya es `null` fuera de `__DEV__`, así que staging/prod y release jamás entran al if.
 */
function resolveBackendUrl(
  explicit: string | undefined,
  derived: string,
): string {
  if (!explicit) return derived;
  if (metroHost) {
    const host = hostOf(explicit);
    if (host !== null && host !== metroHost && isPrivateLanHost(host)) {
      console.warn(
        `[env] el .env apunta a ${host} pero Metro corre en ${metroHost}: IP LAN stale → uso ` +
          `${metroHost}. Vaciá PUBLIC_BFF_URL/PUBLIC_BFF_WS_URL en tu .env de dev para no depender de esto.`,
      );
      return derived;
    }
  }
  return explicit;
}

/**
 * Defaults de dev. En `__DEV__` con host de Metro derivamos del mismo (prioridad 2);
 * si no, fallback por plataforma (prioridad 3).
 */
const devDefaults = (() => {
  if (metroHost) {
    return {
      bffUrl: `http://${metroHost}:4001/api/v1`,
      bffWsUrl: `http://${metroHost}:4001`,
      // tileserver-gl soberano (estilo MapLibre oscuro) servido desde la misma Mac.
      mapStyleUrl: `http://${metroHost}:8082/styles/veo-dark/style.json`,
    };
  }

  // Sin host de Metro: emulador Android no resuelve `localhost` (apunta al propio
  // emulador), por eso usa `10.0.2.2`. iOS / sim usan `localhost`.
  return Platform.OS === 'android'
    ? {
        bffUrl: 'http://10.0.2.2:4001/api/v1',
        bffWsUrl: 'http://10.0.2.2:4001',
        mapStyleUrl: 'http://10.0.2.2:8082/styles/veo-dark/style.json',
      }
    : {
        bffUrl: 'http://localhost:4001/api/v1',
        bffWsUrl: 'http://localhost:4001',
        mapStyleUrl: 'http://localhost:8082/styles/veo-dark/style.json',
      };
})();

/** Esquema de las variables de entorno. Falla rápido si la config es inválida. */
const envSchema = z.object({
  PUBLIC_BFF_URL: z.string().url(),
  PUBLIC_BFF_WS_URL: z.string().url(),
  // Estilo MapLibre oscuro legado (tileserver-gl). Lote 4: el mapa migró a Mapbox y el estilo va
  // embebido en el bundle (`veoDarkStyle`); esta URL queda como fallback opcional.
  PUBLIC_MAP_STYLE_URL: z.string().url(),
  // Token PÚBLICO de Mapbox (`pk.`). Lo consume `Mapbox.setAccessToken` en el bootstrap nativo.
  // Público por diseño (va al cliente), pero NO se commitea: vive en `env/development.secret.env`.
  // Opcional para no romper el arranque en tests/builds sin mapa configurado.
  MAPBOX_ACCESS_TOKEN: z.string().optional().default(''),
  LIVEKIT_URL: z.string().default(''),
  // react-native-config entrega strings; normalizamos el flag a boolean.
  FIREBASE_ENABLED: z
    .string()
    .default('false')
    .transform(value => value === 'true'),
  VEO_ENV: z
    .enum(['development', 'staging', 'production'])
    .default('development'),
});

const parsed = envSchema.safeParse({
  PUBLIC_BFF_URL: resolveBackendUrl(Config.PUBLIC_BFF_URL, devDefaults.bffUrl),
  PUBLIC_BFF_WS_URL: resolveBackendUrl(
    Config.PUBLIC_BFF_WS_URL,
    devDefaults.bffWsUrl,
  ),
  PUBLIC_MAP_STYLE_URL: resolveBackendUrl(
    Config.PUBLIC_MAP_STYLE_URL,
    devDefaults.mapStyleUrl,
  ),
  MAPBOX_ACCESS_TOKEN: Config.MAPBOX_ACCESS_TOKEN ?? '',
  LIVEKIT_URL: Config.LIVEKIT_URL ?? '',
  FIREBASE_ENABLED: Config.FIREBASE_ENABLED ?? 'false',
  VEO_ENV: Config.VEO_ENV ?? 'development',
});

if (!parsed.success) {
  // La app no puede arrancar con una configuración inválida.
  throw new Error(
    `[env] configuración de entorno inválida: ${parsed.error.message}`,
  );
}

/** Acceso tipado y centralizado al entorno. */
export const env = {
  /** Base REST del public-bff (incluye `/api/v1`). */
  publicBffUrl: parsed.data.PUBLIC_BFF_URL,
  /** Host del public-bff para Socket.IO (sin namespace). */
  publicBffWsUrl: parsed.data.PUBLIC_BFF_WS_URL,
  /** URL del estilo MapLibre oscuro legado (tileserver-gl). Lote 4: fallback opcional. */
  mapStyleUrl: parsed.data.PUBLIC_MAP_STYLE_URL,
  /** Token PÚBLICO de Mapbox (`pk.`). Vacío = mapa sin teselas (no rompe el arranque). */
  mapboxAccessToken: parsed.data.MAPBOX_ACCESS_TOKEN,
  /** URL del servidor LiveKit (WebRTC). Vacío = video deshabilitado. */
  livekitUrl: parsed.data.LIVEKIT_URL,
  /** FCM habilitado sólo cuando hay credenciales reales. */
  firebaseEnabled: parsed.data.FIREBASE_ENABLED,
  /** Entorno de ejecución. */
  environment: parsed.data.VEO_ENV,
} as const;

export type AppEnv = typeof env;
