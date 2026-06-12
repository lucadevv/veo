/**
 * Configuración central del harness E2E del golden path.
 *
 * Todos los puertos/URLs vienen de FOUNDATION §2 y de los `.env` reales de cada servicio/BFF.
 * El harness NO inventa puertos: usa los mismos que un arranque `pnpm --filter @veo/<svc> dev`.
 *
 * Infra (dev-stack, quirks ya resueltos en dev-stack/docker-compose.yml):
 *   Postgres host 5433, Redis 6379, Kafka EXTERNAL localhost:9094.
 */

/** Raíz del monorepo (e2e/ -> ../). */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');

/** Infra del dev-stack. Overridable por env para CI/entornos alternos. */
export const INFRA = {
  postgresUrlBase: process.env.E2E_DATABASE_URL_BASE ?? 'postgresql://veo:veo_dev@localhost:5433/veo',
  redisUrl: process.env.E2E_REDIS_URL ?? 'redis://localhost:6379',
  kafkaBroker: process.env.E2E_KAFKA_BROKER ?? 'localhost:9094',
  /** Contenedor Postgres del dev-stack (para el fixture de aprobación del conductor vía docker exec). */
  postgresContainer: process.env.E2E_PG_CONTAINER ?? 'veo-postgres',
} as const;

/** Secretos compartidos (deben coincidir con los `.env` de los servicios/BFFs). */
export const SECRETS = {
  internalIdentitySecret: 'dev-internal-secret-change-me',
  panicHmacSecret: 'dev-panic-hmac-secret-change-me',
  jwtIssuer: 'veo-identity',
  jwtAudience: 'veo-app',
} as const;

/**
 * Par ES256 compartido (PKCS8 + SPKI). Es una clave DEV EXCLUSIVA de este harness e2e: esta es la
 * ÚNICA copia (los `.env` de los servicios NO llevan material de clave — su secreto vive en
 * `dev.secret.env`, gitignored, o lo genera boot-passenger-stack.sh). NUNCA usar con
 * NODE_ENV != development: en prod la keypair la genera/rota terraform vía Secrets Manager.
 * El harness lo inyecta a TODOS los procesos para garantizar que los JWT que emite identity
 * los validen ambos BFFs (si difirieran, el login no autenticaría aguas arriba).
 */
export const JWT_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg+rTklkb3rLcyhyVr
zMyFEVUpHN3DakSu4vZZpzosFjShRANCAATVE4yoJdiyiDnHM1Xe+NuwdW0ivy5M
js53VaRCFKnUhg3AuKgCMeI/ed0JQyBxH8EDLOH5EUaohmRizS9Ttd1g
-----END PRIVATE KEY-----`;

export const JWT_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE1ROMqCXYsog5xzNV3vjbsHVtIr8u
TI7Od1WkQhSp1IYNwLioAjHiP3ndCUMgcR/BAyzh+RFGqIZkYs0vU7XdYA==
-----END PUBLIC KEY-----`;

export interface ServiceSpec {
  /** Nombre lógico (para logs). */
  name: string;
  /** Filtro pnpm workspace (`@veo/<x>`). */
  filter: string;
  /** Directorio del proyecto, relativo a la raíz del monorepo (para CWD del proceso). */
  cwd: string;
  /** Puerto HTTP (/api/v1 + /health). */
  httpPort: number;
  /** Path del health check. Default `/health` (todos los servicios lo exponen sin prefijo). */
  healthPath?: string;
  /** Si tiene Prisma generado en src/generated (hay que copiarlo a dist tras el build). */
  hasPrismaGenerated?: boolean;
  /** Si cualquier respuesta HTTP (incl. 401) cuenta como "arriba" (public-bff gatea /health). */
  healthAcceptAnyStatus?: boolean;
  /** host:port gRPC, si el servicio expone gRPC (microservicios Ola 1). */
  grpcUrl?: string;
  /** Schema Postgres propio (si tiene base de datos). */
  dbSchema?: string;
  /** Env extra específica del proceso. */
  env: Record<string, string>;
}

/**
 * URL HTTP base de cada servicio/BFF (sin /api/v1; los clientes lo añaden).
 * Las usa el orquestador para los health checks y el test para hablar con los BFFs.
 */
export const PORTS = {
  // Overridable: en la máquina de dev el 3001 puede estar ocupado por otro stack (docker).
  identity: Number(process.env.E2E_IDENTITY_PORT ?? 3001),
  trip: 3002,
  dispatch: 3003,
  payment: 3005,
  panic: 3006,
  publicBff: 4001,
  driverBff: 4002,
} as const;

export const BASE_URLS = {
  publicBff: `http://localhost:${PORTS.publicBff}`,
  driverBff: `http://localhost:${PORTS.driverBff}`,
} as const;

/**
 * Env común a TODOS los procesos (infra + secretos + claves + modos sandbox).
 * Forzamos `VEO_MAPS_MODE=local` para que el golden path NO dependa del perfil `maps`
 * (OSRM/Nominatim): @veo/maps usa el motor local determinista. Forzamos sandbox en SMS,
 * biometría y pagos (sin terceros). NODE_ENV=development para permitir claves dev.
 */
export function commonEnv(): Record<string, string> {
  return {
    NODE_ENV: 'development',
    LOG_LEVEL: process.env.E2E_SERVICE_LOG_LEVEL ?? 'warn',
    REDIS_URL: INFRA.redisUrl,
    KAFKA_BROKERS: INFRA.kafkaBroker,
    // 'local' (determinista, golden path) o 'osrm' (geocoding/routing real del dev-stack maps).
    // Overridable por `E2E_MAPS_MODE` para probar en dispositivo con direcciones reales de Lima.
    VEO_MAPS_MODE: process.env.E2E_MAPS_MODE ?? 'local',
    OSRM_URL: process.env.E2E_OSRM_URL ?? 'http://localhost:5005',
    NOMINATIM_URL: process.env.E2E_NOMINATIM_URL ?? 'http://localhost:8091',
    // Token de Mapbox para TODOS los servicios (no solo public-bff): trip/dispatch/driver-bff ya
    // soportan VEO_MAPS_MODE=mapbox, y su superRefine lo exige cuando el modo es mapbox. Vacío si no
    // se corre en modo mapbox (el superRefine solo dispara con mode=mapbox).
    MAPBOX_ACCESS_TOKEN: process.env.MAPBOX_ACCESS_TOKEN ?? '',
    VEO_SMS_MODE: 'sandbox',
    VEO_BIOMETRIC_MODE: 'sandbox',
    VEO_PAYMENT_MODE: 'sandbox',
    VEO_EVIDENCE_MODE: 'sandbox',
    // Secretos compartidos
    INTERNAL_IDENTITY_SECRET: SECRETS.internalIdentitySecret,
    VEO_INTERNAL_IDENTITY_SECRET: SECRETS.internalIdentitySecret,
    PANIC_HMAC_SECRET: SECRETS.panicHmacSecret,
    // JWT ES256 (mismo par para emisor identity y verificadores BFF)
    JWT_ISSUER: SECRETS.jwtIssuer,
    JWT_AUDIENCE: SECRETS.jwtAudience,
    JWT_PRIVATE_KEY_PEM,
    JWT_PUBLIC_KEY_PEM,
    VEO_JWT_ISSUER: SECRETS.jwtIssuer,
    VEO_JWT_AUDIENCE: SECRETS.jwtAudience,
    VEO_JWT_PUBLIC_PEM: JWT_PUBLIC_KEY_PEM,
  };
}

function dbUrl(schema: string): string {
  return `${INFRA.postgresUrlBase}?schema=${schema}`;
}

/** Los 5 microservicios Ola 1 del golden path. */
export function serviceSpecs(): ServiceSpec[] {
  return [
    {
      name: 'identity-service',
      filter: '@veo/identity-service',
      cwd: 'services/identity-service',
      httpPort: PORTS.identity,
      // identity-service excluye `health` del global prefix (como trip/dispatch/bff) → vive en /health.
      healthPath: '/health',
      hasPrismaGenerated: true,
      grpcUrl: '0.0.0.0:50051',
      dbSchema: 'identity',
      env: { PORT: String(PORTS.identity), GRPC_URL: '0.0.0.0:50051', DATABASE_URL: dbUrl('identity') },
    },
    {
      name: 'trip-service',
      filter: '@veo/trip-service',
      cwd: 'services/trip-service',
      hasPrismaGenerated: true,
      httpPort: PORTS.trip,
      grpcUrl: '0.0.0.0:50052',
      dbSchema: 'trip',
      env: { PORT: String(PORTS.trip), GRPC_URL: '0.0.0.0:50052', DATABASE_URL: dbUrl('trip') },
    },
    {
      name: 'dispatch-service',
      filter: '@veo/dispatch-service',
      cwd: 'services/dispatch-service',
      hasPrismaGenerated: true,
      httpPort: PORTS.dispatch,
      grpcUrl: '0.0.0.0:50053',
      dbSchema: 'dispatch',
      env: {
        PORT: String(PORTS.dispatch),
        GRPC_URL: '0.0.0.0:50053',
        DATABASE_URL: dbUrl('dispatch'),
        // Margen amplio para que el test reciba la oferta y la acepte sin carrera en máquinas lentas.
        DISPATCH_OFFER_TIMEOUT_MS: '30000',
      },
    },
    {
      name: 'payment-service',
      filter: '@veo/payment-service',
      cwd: 'services/payment-service',
      hasPrismaGenerated: true,
      httpPort: PORTS.payment,
      grpcUrl: '0.0.0.0:50055',
      dbSchema: 'payment',
      env: { PORT: String(PORTS.payment), GRPC_URL: '0.0.0.0:50055', DATABASE_URL: dbUrl('payment') },
    },
    {
      name: 'panic-service',
      filter: '@veo/panic-service',
      cwd: 'services/panic-service',
      hasPrismaGenerated: true,
      httpPort: PORTS.panic,
      grpcUrl: '0.0.0.0:50056',
      dbSchema: 'panic',
      env: { PORT: String(PORTS.panic), GRPC_URL: '0.0.0.0:50056', DATABASE_URL: dbUrl('panic') },
    },
    // Servicios adicionales (no del golden path, pero requeridos por el dashboard del conductor y
    // features completas al probar en dispositivo): rating, fleet, share, notification, media, chat.
    {
      name: 'rating-service', filter: '@veo/rating-service', cwd: 'services/rating-service',
      hasPrismaGenerated: true, healthAcceptAnyStatus: true, httpPort: 3010, grpcUrl: '0.0.0.0:50060', dbSchema: 'rating',
      env: { PORT: '3010', GRPC_URL: '0.0.0.0:50060', DATABASE_URL: dbUrl('rating') },
    },
    {
      name: 'fleet-service', filter: '@veo/fleet-service', cwd: 'services/fleet-service',
      hasPrismaGenerated: true, healthAcceptAnyStatus: true, httpPort: 3012, grpcUrl: '0.0.0.0:50062', dbSchema: 'fleet',
      env: { PORT: '3012', GRPC_URL: '0.0.0.0:50062', DATABASE_URL: dbUrl('fleet') },
    },
    {
      name: 'share-service', filter: '@veo/share-service', cwd: 'services/share-service',
      hasPrismaGenerated: true, healthAcceptAnyStatus: true, httpPort: 3011, grpcUrl: '0.0.0.0:50061', dbSchema: 'share',
      env: { PORT: '3011', GRPC_URL: '0.0.0.0:50061', DATABASE_URL: dbUrl('share') },
    },
    {
      name: 'notification-service', filter: '@veo/notification-service', cwd: 'services/notification-service',
      hasPrismaGenerated: true, healthAcceptAnyStatus: true, httpPort: 3008, dbSchema: 'notification',
      env: { PORT: '3008', DATABASE_URL: dbUrl('notification') },
    },
    {
      name: 'media-service', filter: '@veo/media-service', cwd: 'services/media-service',
      hasPrismaGenerated: true, healthAcceptAnyStatus: true, httpPort: 3007, grpcUrl: '0.0.0.0:50057', dbSchema: 'media',
      env: { PORT: '3007', GRPC_URL: '0.0.0.0:50057', DATABASE_URL: dbUrl('media') },
    },
    {
      name: 'chat-service', filter: '@veo/chat-service', cwd: 'services/chat-service',
      hasPrismaGenerated: true, healthAcceptAnyStatus: true, httpPort: 3014, dbSchema: 'chat',
      env: { PORT: '3014', DATABASE_URL: dbUrl('chat') },
    },
  ];
}

/** Los 2 BFFs del golden path (public + driver), apuntando a los servicios de arriba. */
export function bffSpecs(): ServiceSpec[] {
  const downstreamGrpc = {
    IDENTITY_GRPC_URL: 'localhost:50051',
    TRIP_GRPC_URL: 'localhost:50052',
    DISPATCH_GRPC_URL: 'localhost:50053',
    PAYMENT_GRPC_URL: 'localhost:50055',
    PANIC_GRPC_URL: 'localhost:50056',
    RATING_GRPC_URL: 'localhost:50060',
    SHARE_GRPC_URL: 'localhost:50061',
    FLEET_GRPC_URL: 'localhost:50062',
  };

  return [
    {
      name: 'public-bff',
      filter: '@veo/public-bff',
      cwd: 'services/bff/public-bff',
      httpPort: PORTS.publicBff,
      // public-bff aplica JwtAuthGuard global → /health responde 401; el proceso está arriba igual.
      healthAcceptAnyStatus: true,
      env: {
        PORT: String(PORTS.publicBff),
        ...downstreamGrpc,
        // El reverse-geocode/autocomplete del Home (la dirección que ve el pasajero) lo sirve SOLO el
        // public-bff. Le damos su propio modo de mapas para usar Mapbox (direcciones reales) sin tocar a
        // los demás servicios: trip/dispatch aún NO aceptan 'mapbox' en su enum (drift de contrato), así
        // que quedan en su modo del commonEnv (local/osrm) para rutas. Override por var dedicada.
        VEO_MAPS_MODE: process.env.PUBLIC_BFF_MAPS_MODE ?? process.env.E2E_MAPS_MODE ?? 'local',
        MAPBOX_ACCESS_TOKEN: process.env.MAPBOX_ACCESS_TOKEN ?? '',
        // REST interno: public-bff AÑADE /api/v1 a la baseUrl (env.schema).
        IDENTITY_URL: `http://localhost:${PORTS.identity}/api/v1`,
        TRIP_URL: `http://localhost:${PORTS.trip}/api/v1`,
        PAYMENT_URL: `http://localhost:${PORTS.payment}/api/v1`,
        PANIC_URL: `http://localhost:${PORTS.panic}/api/v1`,
        RATING_URL: `http://localhost:3010/api/v1`,
        SHARE_URL: `http://localhost:3011/api/v1`,
        NOTIFICATION_URL: `http://localhost:3008/api/v1`,
        CHAT_URL: `http://localhost:3014/api/v1`,
      },
    },
    {
      name: 'driver-bff',
      filter: '@veo/driver-bff',
      cwd: 'services/bff/driver-bff',
      httpPort: PORTS.driverBff,
      env: {
        PORT: String(PORTS.driverBff),
        KAFKA_GROUP_ID: 'driver-bff-e2e',
        ...downstreamGrpc,
        // REST interno: driver-bff NO añade prefijo aquí (lo hace el cliente).
        IDENTITY_URL: `http://localhost:${PORTS.identity}`,
        TRIP_URL: `http://localhost:${PORTS.trip}`,
        DISPATCH_URL: `http://localhost:${PORTS.dispatch}`,
        PAYMENT_URL: `http://localhost:${PORTS.payment}`,
        PAYOUTS_URL: `http://localhost:${PORTS.payment}`,
        NOTIFICATION_URL: `http://localhost:3008`,
        FLEET_URL: `http://localhost:3012`,
        MEDIA_URL: `http://localhost:3007`,
        CHAT_URL: `http://localhost:3014`,
      },
    },
  ];
}
