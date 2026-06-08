import { NativeModules, Platform } from 'react-native';
import Config from 'react-native-config';
import { z } from 'zod';

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
 * Deriva el HOST (IP/hostname) del packager Metro a partir de
 * `NativeModules.SourceCode.scriptURL`.
 *
 * En dev sobre device físico el bundle se sirve desde la IP de la Mac, p.ej.
 * `"http://192.168.18.227:8081/index.bundle?platform=ios&dev=true"` → devuelve `"192.168.18.227"`.
 *
 * En release el bundle es local (`"file:///.../main.jsbundle"`, sin host) → devuelve `null`.
 *
 * Robusta por diseño: cualquier scriptURL que no sea http(s) con host, o cualquier error,
 * devuelve `null` para caer en el fallback localhost/10.0.2.2.
 */
export function metroDevHost(): string | null {
  try {
    const scriptURL: unknown = NativeModules?.SourceCode?.scriptURL;
    if (typeof scriptURL !== 'string' || scriptURL.length === 0) {
      return null;
    }
    // Sólo nos interesa el packager http(s); file:// (release) y otros esquemas → null.
    const match = /^https?:\/\/([^/:?#]+)(?::\d+)?/i.exec(scriptURL);
    const host = match?.[1];
    return host && host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

/**
 * Defaults de dev. En `__DEV__` con host de Metro derivamos del mismo (prioridad 2);
 * si no, fallback por plataforma (prioridad 3).
 */
const devDefaults = (() => {
  const metroHost = __DEV__ ? metroDevHost() : null;

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
  // Público por diseño (va al cliente), pero NO se commitea: vive en `env/dev.secret.env`.
  // Opcional para no romper el arranque en tests/builds sin mapa configurado.
  MAPBOX_ACCESS_TOKEN: z.string().optional().default(''),
  LIVEKIT_URL: z.string().default(''),
  // react-native-config entrega strings; normalizamos el flag a boolean.
  FIREBASE_ENABLED: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),
  VEO_ENV: z
    .enum(['development', 'staging', 'production'])
    .default('development'),
});

const parsed = envSchema.safeParse({
  PUBLIC_BFF_URL: Config.PUBLIC_BFF_URL || devDefaults.bffUrl,
  PUBLIC_BFF_WS_URL: Config.PUBLIC_BFF_WS_URL || devDefaults.bffWsUrl,
  PUBLIC_MAP_STYLE_URL: Config.PUBLIC_MAP_STYLE_URL || devDefaults.mapStyleUrl,
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
