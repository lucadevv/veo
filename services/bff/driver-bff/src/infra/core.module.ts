/**
 * CoreModule (global) — singletons de infraestructura del BFF:
 *  - Redis (rate limiting).
 *  - JwtService ES256 en modo SOLO verificación (la clave privada vive en identity-service).
 *  - Secreto HMAC de identidad interna (para firmar la propagación aguas abajo).
 *  - JwtAuthGuard de @veo/auth (validación del Bearer en el gateway, FOUNDATION §7).
 *  - Gateways downstream: gRPC (lecturas) y REST interno firmado (comandos).
 */
import { Global, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  JwtService,
  JwtAuthGuard,
  JWT_SERVICE,
  INTERNAL_IDENTITY_SECRET,
  generateDevKeyPairPem,
  type JwtKeys,
} from '@veo/auth';
import { redisProvider, RedisLifecycle, REDIS } from './redis';
import { GrpcGateway } from './grpc.gateway';
import { RestGateway } from './rest.gateway';
import { MAPS, buildMapsClient } from './maps.client';
import type { Env } from '../config/env.schema';

/**
 * Resuelve las claves JWT. El BFF solo verifica, por lo que la privada nunca se usa para firmar:
 * en producción exigimos la pública; en dev, si falta, generamos un par efímero.
 */
async function resolveJwtKeys(config: ConfigService<Env, true>): Promise<JwtKeys> {
  const publicPem = config.get<string>('VEO_JWT_PUBLIC_PEM');
  if (publicPem) {
    return {
      // La privada no se usa nunca en el BFF (no firma tokens); se deja vacía a propósito.
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
  useFactory: (config: ConfigService<Env, true>) =>
    resolveJwtKeys(config).then((keys) => new JwtService(keys)),
};

const internalSecretProvider: Provider = {
  provide: INTERNAL_IDENTITY_SECRET,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    config.getOrThrow<string>('VEO_INTERNAL_IDENTITY_SECRET'),
};

/** Fachada de mapas OSM (Ola 2C · navegación turn-by-turn): OSRM con fallback al motor local. */
const mapsProvider: Provider = {
  provide: MAPS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    buildMapsClient({
      mode: config.getOrThrow<Env['VEO_MAPS_MODE']>('VEO_MAPS_MODE'),
      osrmUrl: config.getOrThrow<string>('OSRM_URL'),
      nominatimUrl: config.getOrThrow<string>('NOMINATIM_URL'),
      mapboxAccessToken: config.get<string>('MAPBOX_ACCESS_TOKEN'),
    }),
};

@Global()
@Module({
  providers: [
    redisProvider,
    RedisLifecycle,
    jwtProvider,
    { provide: JWT_SERVICE, useExisting: JwtService },
    internalSecretProvider,
    mapsProvider,
    JwtAuthGuard,
    GrpcGateway,
    RestGateway,
  ],
  exports: [
    REDIS,
    JwtService,
    JWT_SERVICE,
    INTERNAL_IDENTITY_SECRET,
    MAPS,
    JwtAuthGuard,
    GrpcGateway,
    RestGateway,
  ],
})
export class CoreModule {}
