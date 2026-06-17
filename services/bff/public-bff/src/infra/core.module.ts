/**
 * CoreModule (global): singletons de infraestructura del BFF.
 * - Redis (rate limit + readiness).
 * - JwtService (solo verificación ES256 con la clave pública) + secreto de identidad interna.
 * - Clientes gRPC (lecturas) y REST interno firmado (comandos) por cada servicio downstream.
 * - Fachada de mapas (OSRM con fallback local).
 */
import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  JwtService,
  JWT_SERVICE,
  INTERNAL_IDENTITY_SECRET,
  generateDevKeyPairPem,
  type JwtKeys,
} from '@veo/auth';
import { type MapsMode } from '@veo/maps';
import { createGrpcClient, InternalRestClient, type ServiceName } from '@veo/rpc';
import { REDIS, redisProvider } from './redis';
import { buildMapsClient } from './maps.client';
import {
  GRPC_DISPATCH,
  GRPC_FLEET,
  GRPC_IDENTITY,
  GRPC_PANIC,
  GRPC_PAYMENT,
  GRPC_PLACES,
  GRPC_RATING,
  GRPC_SHARE,
  GRPC_TRIP,
  LIVEKIT,
  MAPS,
  REST_IDENTITY,
  REST_NOTIFICATION,
  REST_CHAT,
  REST_MEDIA,
  REST_PANIC,
  REST_PAYMENT,
  REST_RATING,
  REST_SHARE,
  REST_TRIP,
  REST_DISPATCH,
} from './downstream.tokens';
import type { LiveKitConfig } from '../share/livekit-token';
import type { Env } from '../config/env.schema';

/** Resuelve las claves JWT. Solo se valida (clave pública); en dev se genera un par efímero. */
async function resolveJwtKeys(config: ConfigService<Env, true>): Promise<JwtKeys> {
  const publicPem = config.get<string>('VEO_JWT_PUBLIC_PEM');
  if (publicPem) {
    return {
      privatePem: '',
      publicPem,
      issuer: config.getOrThrow<string>('VEO_JWT_ISSUER'),
      audience: config.getOrThrow<string>('VEO_JWT_AUDIENCE'),
      accessTtl: '15m',
      refreshTtl: '30d',
    };
  }
  if (config.getOrThrow<string>('NODE_ENV') === 'production') {
    throw new Error('VEO_JWT_PUBLIC_PEM es obligatorio en producción');
  }
  const generated = await generateDevKeyPairPem();
  return {
    privatePem: generated.privatePem,
    publicPem: generated.publicPem,
    issuer: config.getOrThrow<string>('VEO_JWT_ISSUER'),
    audience: config.getOrThrow<string>('VEO_JWT_AUDIENCE'),
    accessTtl: '15m',
    refreshTtl: '30d',
  };
}

const jwtProvider: Provider = {
  provide: JwtService,
  inject: [ConfigService],
  useFactory: async (config: ConfigService<Env, true>) =>
    new JwtService(await resolveJwtKeys(config)),
};

const internalSecretProvider: Provider = {
  provide: INTERNAL_IDENTITY_SECRET,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    config.getOrThrow<string>('VEO_INTERNAL_IDENTITY_SECRET'),
};

/** Crea el provider de un cliente gRPC para un servicio, leyendo su URL de la config. */
function grpcProvider(token: symbol, service: ServiceName, urlKey: keyof Env): Provider {
  return {
    provide: token,
    inject: [ConfigService],
    useFactory: (config: ConfigService<Env, true>) =>
      createGrpcClient(service, {
        url: config.getOrThrow<string>(urlKey),
        deadlineMs: config.getOrThrow<number>('GRPC_DEADLINE_MS'),
      }),
  };
}

/** Crea el provider de un cliente REST interno firmado para un servicio. */
function restProvider(token: symbol, urlKey: keyof Env): Provider {
  return {
    provide: token,
    inject: [ConfigService],
    useFactory: (config: ConfigService<Env, true>) =>
      new InternalRestClient({
        baseUrl: config.getOrThrow<string>(urlKey),
        secret: config.getOrThrow<string>('VEO_INTERNAL_IDENTITY_SECRET'),
        timeoutMs: config.getOrThrow<number>('REST_TIMEOUT_MS'),
      }),
  };
}

const mapsProvider: Provider = {
  provide: MAPS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    buildMapsClient({
      // MapsMode de @veo/maps: la fuente única del union (env.schema valida con z.enum(MAPS_MODES)).
      mode: config.getOrThrow<MapsMode>('VEO_MAPS_MODE'),
      osrmUrl: config.getOrThrow<string>('OSRM_URL'),
      nominatimUrl: config.getOrThrow<string>('NOMINATIM_URL'),
      mapboxAccessToken: config.get<string>('MAPBOX_ACCESS_TOKEN'),
    }),
};

const livekitProvider: Provider = {
  provide: LIVEKIT,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): LiveKitConfig => ({
    url: config.getOrThrow<string>('LIVEKIT_URL'),
    apiKey: config.getOrThrow<string>('LIVEKIT_API_KEY'),
    apiSecret: config.getOrThrow<string>('LIVEKIT_API_SECRET'),
    ttlSec: config.getOrThrow<number>('LIVEKIT_GRANT_TTL_SEC'),
  }),
};

const grpcProviders: Provider[] = [
  grpcProvider(GRPC_IDENTITY, 'identity', 'IDENTITY_GRPC_URL'),
  grpcProvider(GRPC_TRIP, 'trip', 'TRIP_GRPC_URL'),
  grpcProvider(GRPC_DISPATCH, 'dispatch', 'DISPATCH_GRPC_URL'),
  grpcProvider(GRPC_PAYMENT, 'payment', 'PAYMENT_GRPC_URL'),
  grpcProvider(GRPC_PANIC, 'panic', 'PANIC_GRPC_URL'),
  grpcProvider(GRPC_RATING, 'rating', 'RATING_GRPC_URL'),
  grpcProvider(GRPC_SHARE, 'share', 'SHARE_GRPC_URL'),
  grpcProvider(GRPC_FLEET, 'fleet', 'FLEET_GRPC_URL'),
  grpcProvider(GRPC_PLACES, 'places', 'PLACES_GRPC_URL'),
];

const restProviders: Provider[] = [
  restProvider(REST_IDENTITY, 'IDENTITY_URL'),
  restProvider(REST_TRIP, 'TRIP_URL'),
  restProvider(REST_DISPATCH, 'DISPATCH_URL'),
  restProvider(REST_PAYMENT, 'PAYMENT_URL'),
  restProvider(REST_PANIC, 'PANIC_URL'),
  restProvider(REST_SHARE, 'SHARE_URL'),
  restProvider(REST_RATING, 'RATING_URL'),
  restProvider(REST_NOTIFICATION, 'NOTIFICATION_URL'),
  restProvider(REST_CHAT, 'CHAT_URL'),
  restProvider(REST_MEDIA, 'MEDIA_URL'),
];

const tokens = [
  REDIS,
  JwtService,
  JWT_SERVICE,
  INTERNAL_IDENTITY_SECRET,
  MAPS,
  LIVEKIT,
  GRPC_IDENTITY,
  GRPC_TRIP,
  GRPC_DISPATCH,
  GRPC_PAYMENT,
  GRPC_PANIC,
  GRPC_RATING,
  GRPC_SHARE,
  GRPC_FLEET,
  GRPC_PLACES,
  REST_IDENTITY,
  REST_TRIP,
  REST_DISPATCH,
  REST_PAYMENT,
  REST_PANIC,
  REST_SHARE,
  REST_RATING,
  REST_NOTIFICATION,
  REST_CHAT,
  REST_MEDIA,
];

@Global()
@Module({
  providers: [
    redisProvider,
    jwtProvider,
    { provide: JWT_SERVICE, useExisting: JwtService },
    internalSecretProvider,
    mapsProvider,
    livekitProvider,
    ...grpcProviders,
    ...restProviders,
  ],
  exports: tokens,
})
export class CoreModule {}
