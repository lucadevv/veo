import {Platform} from 'react-native';
import Config from 'react-native-config';
import {z} from 'zod';

/**
 * Configuración de entorno tipada y validada con zod.
 *
 * Fuente: `react-native-config` (lee el `.env` en tiempo de build). Cuando una variable
 * no está presente (p. ej. en pruebas o builds de desarrollo) se aplican defaults
 * dependientes de plataforma:
 *  - Android emulador alcanza la máquina host por `10.0.2.2`.
 *  - iOS simulador la alcanza por `localhost`.
 *
 * La app SIEMPRE habla con el `driver-bff` (nunca con microservicios directos). La REST
 * vive bajo el prefijo `/api/v1`; el Socket.IO usa el namespace `/driver`.
 */
const isAndroid = Platform.OS === 'android';

const DEFAULT_BFF_URL = isAndroid
  ? 'http://10.0.2.2:4002/api/v1'
  : 'http://localhost:4002/api/v1';

const DEFAULT_WS_URL = isAndroid ? 'http://10.0.2.2:4002' : 'http://localhost:4002';

// Estilo/tiles servidos por nuestro tileserver-gl propio (soberanía: sin tiles de terceros).
const DEFAULT_MAP_STYLE_URL = isAndroid
  ? 'http://10.0.2.2:8082/styles/veo-dark/style.json'
  : 'http://localhost:8082/styles/veo-dark/style.json';

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
    DRIVER_BFF_URL: Config.DRIVER_BFF_URL ?? DEFAULT_BFF_URL,
    DRIVER_BFF_WS_URL: Config.DRIVER_BFF_WS_URL ?? DEFAULT_WS_URL,
    LIVEKIT_URL: Config.LIVEKIT_URL ?? '',
    MAPBOX_ACCESS_TOKEN: Config.MAPBOX_ACCESS_TOKEN ?? '',
    MAP_STYLE_URL: Config.MAP_STYLE_URL || DEFAULT_MAP_STYLE_URL,
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
