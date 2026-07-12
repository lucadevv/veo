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
 *     Es la fuente de verdad para staging/prod (release: gana siempre, sin excepciones).
 *     EXCEPCIÓN sólo en `__DEV__` con packager vivo (auto-sanado anti-stale): TODO override cuyo
 *     host NO sea el host vivo de Metro se trata como stale y se ignora (con aviso por consola) —
 *     cubre la IP LAN rotada por DHCP, el dominio de un túnel muerto BAKEADO en el build nativo
 *     (react-native-config hornea los valores: editar el .env no afecta al build instalado hasta
 *     el próximo build) y `localhost` en un device físico. Para apuntar un build dev a staging o
 *     a un host fijo a propósito: `DEV_FORCE_ENV_URLS=true` en el .env (y rebuild).
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

/** Host (IP/hostname) de una URL http(s); `null` si no parsea. */
function hostOf(url: string): string | null {
  return /^https?:\/\/([^/:?#]+)/i.exec(url)?.[1] ?? null;
}

/** Host VIVO del packager Metro en dev (la IP ACTUAL de la Mac); `null` fuera de dev o sin packager. */
const metroHost = __DEV__ ? metroDevHost() : null;

/**
 * Escape hatch del auto-sanado (sólo relevante en `__DEV__`): con `DEV_FORCE_ENV_URLS=true` en el
 * .env, los overrides se honran tal cual aunque su host no sea el de Metro (staging, túnel, IP fija).
 */
const forceEnvUrls = Config.DEV_FORCE_ENV_URLS === 'true';

/**
 * Resuelve una URL de backend con AUTO-SANADO de overrides stale en dev (prioridad 1 del header).
 * Sin override → el `derived` (metro/fallback). Con override → gana, SALVO en `__DEV__` con
 * packager vivo: si su host NO es el host de Metro (IP LAN rotada, dominio de túnel muerto bakeado
 * en el build, localhost en device físico) se usa el host de Metro y se avisa por consola.
 * `DEV_FORCE_ENV_URLS=true` lo desactiva. `metroHost` ya es `null` fuera de `__DEV__`, así que
 * staging/prod y release jamás entran al if.
 */
function resolveBackendUrl(
  explicit: string | undefined,
  derived: string,
): string {
  if (!explicit) return derived;
  if (metroHost && !forceEnvUrls) {
    const host = hostOf(explicit);
    if (host !== null && host !== metroHost) {
      console.warn(
        `[env] el .env (bakeado en el build nativo) apunta a ${host} pero Metro corre en ` +
          `${metroHost}: override stale → uso ${metroHost}. Para forzarlo en dev seteá ` +
          `DEV_FORCE_ENV_URLS=true en el .env (y rebuild).`,
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
  // Estilo MapLibre legado (tileserver-gl). Lote 4: el mapa migró a Mapbox y el estilo va embebido
  // en el bundle (`veoLightStyle`, Daylight Trust); esta URL queda como fallback opcional.
  PUBLIC_MAP_STYLE_URL: z.string().url(),
  // Token PÚBLICO de Mapbox (`pk.`). Lo consume `Mapbox.setAccessToken` en el bootstrap nativo.
  // Público por diseño (va al cliente): vive en `env/<tier>.env` (single-file), restringido por bundle-id en Mapbox.
  // Opcional para no romper el arranque en tests/builds sin mapa configurado.
  MAPBOX_ACCESS_TOKEN: z.string().optional().default(''),
  LIVEKIT_URL: z.string().default(''),
  // react-native-config entrega strings; normalizamos el flag a boolean.
  FIREBASE_ENABLED: z
    .string()
    .default('false')
    .transform(value => value === 'true'),
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
} as const;

export type AppEnv = typeof env;
