/**
 * @veo/redis
 *
 * Factory de cliente ioredis RESILIENTE, compartido por todos los servicios que hablan con Redis.
 *
 * ¿Por qué existe este package?
 * El patrón copy-pasteado en 13+ servicios era `new Redis(url, { maxRetriesPerRequest: 3 })`
 * SIN handler de 'error'. Ante un rebote transitorio de Redis (failover, blip de red, restart),
 * ioredis lanza `MaxRetriesPerRequestError` tras 3 intentos; al no haber listener de 'error',
 * Node lo trata como un evento 'error' no manejado y MATA el proceso. En payment-service
 * (servicio de DINERO con outbox relay) esto se diagnosticó en vivo y se corrigió con la config
 * que acá se centraliza: `maxRetriesPerRequest: null` (reintento indefinido en vez de tirar el
 * error), `enableReadyCheck: true`, backoff con techo, y un handler de 'error' que LOGUEA sin
 * relanzar ni matar el proceso. Ver `services/payment-service/src/infra/redis.ts`.
 */
import { Redis } from 'ioredis';

/**
 * Subset mínimo de un logger (compatible con `@nestjs/common` Logger, console, pino, etc.).
 * Se mantiene chico a propósito para no acoplar este package a ningún framework de logging.
 */
export interface RedisLogger {
  warn(message: string, ...args: unknown[]): void;
}

/**
 * Opciones del factory. Todas opcionales: sin opts el cliente igual nace resiliente.
 */
export interface CreateRedisOptions {
  /** Logger para los eventos de error de conexión. Si no se pasa, los errores se tragan en silencio. */
  logger?: RedisLogger;
  /** Prefijo aplicado a todas las keys (aislamiento por servicio / namespace). */
  keyPrefix?: string;
  /** Si es `true`, no conecta hasta el primer comando (útil en tests / arranque diferido). */
  lazyConnect?: boolean;
  /** Nombre de conexión visible en `CLIENT LIST` de Redis (debugging / observabilidad). */
  connectionName?: string;
}

/**
 * Constantes del backoff de reconexión (NO números mágicos).
 * `retryStrategy` recibe el nº de intento y devuelve los ms a esperar antes de reintentar.
 */
const RETRY_BACKOFF_STEP_MS = 200 as const;
const RETRY_BACKOFF_MAX_MS = 5_000 as const;

/**
 * Crea un cliente ioredis resiliente.
 *
 * Config no negociable (probada en producción en payment-service):
 * - `maxRetriesPerRequest: null` → reintenta indefinidamente en lugar de lanzar
 *   `MaxRetriesPerRequestError` (que sin handler mata el proceso).
 * - `enableReadyCheck: true` → no marca la conexión como lista hasta que Redis responde a INFO.
 * - `retryStrategy` → backoff lineal con techo de {@link RETRY_BACKOFF_MAX_MS}ms para no
 *   martillar la infra mientras está caída.
 * - handler `on('error')` → loguea vía `opts.logger?.warn` SIN relanzar; así el evento 'error'
 *   queda manejado y Node no tumba el proceso durante un blip transitorio.
 *
 * @param url URL de conexión (`redis://...` / `rediss://...`).
 * @param opts Opciones opcionales (logger, keyPrefix, lazyConnect, connectionName).
 * @returns Instancia de {@link Redis} ya configurada y con el handler de error enganchado.
 */
export function createRedisClient(url: string, opts: CreateRedisOptions = {}): Redis {
  const { logger, keyPrefix, lazyConnect, connectionName } = opts;

  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times: number): number =>
      Math.min(times * RETRY_BACKOFF_STEP_MS, RETRY_BACKOFF_MAX_MS),
    ...(keyPrefix !== undefined ? { keyPrefix } : {}),
    ...(lazyConnect !== undefined ? { lazyConnect } : {}),
    ...(connectionName !== undefined ? { connectionName } : {}),
  });

  client.on('error', (err: Error): void => {
    logger?.warn(`Redis connection error (auto-retry in progress): ${err.message}`);
  });

  return client;
}

export type { Redis };
