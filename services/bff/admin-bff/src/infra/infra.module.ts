/**
 * InfraModule (global): provee la conexión Redis y los clientes downstream.
 * - gRPC para LECTURAS (createGrpcClient de @veo/rpc).
 * - REST interno firmado HMAC para COMANDOS (InternalRestClient de @veo/rpc).
 * Todos se construyen desde la config validada; sin estado global ni hardcodeo.
 */
import {
  Global,
  Module,
  type Provider,
  type OnApplicationShutdown,
  Injectable,
  Inject,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRedisClient, type Redis } from '@veo/redis';
import { createGrpcClient, InternalRestClient, type GrpcServiceClient } from '@veo/rpc';
import type { Env } from '../config/env.schema';
import {
  REDIS,
  GRPC_IDENTITY,
  GRPC_TRIP,
  GRPC_PANIC,
  GRPC_PAYMENT,
  GRPC_MEDIA,
  GRPC_AUDIT,
  GRPC_RATING,
  GRPC_FLEET,
  REST_IDENTITY,
  REST_TRIP,
  REST_PANIC,
  REST_PAYMENT,
  REST_MEDIA,
  REST_AUDIT,
  REST_FLEET,
  REST_DISPATCH,
} from './tokens';

/** Cierra los clientes gRPC y Redis al apagar el proceso. */
@Injectable()
export class InfraLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(GRPC_IDENTITY) private readonly identity: GrpcServiceClient,
    @Inject(GRPC_TRIP) private readonly trip: GrpcServiceClient,
    @Inject(GRPC_PANIC) private readonly panic: GrpcServiceClient,
    @Inject(GRPC_PAYMENT) private readonly payment: GrpcServiceClient,
    @Inject(GRPC_MEDIA) private readonly media: GrpcServiceClient,
    @Inject(GRPC_AUDIT) private readonly audit: GrpcServiceClient,
    @Inject(GRPC_RATING) private readonly rating: GrpcServiceClient,
    @Inject(GRPC_FLEET) private readonly fleet: GrpcServiceClient,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    for (const c of [
      this.identity,
      this.trip,
      this.panic,
      this.payment,
      this.media,
      this.audit,
      this.rating,
      this.fleet,
    ]) {
      try {
        c.close();
      } catch {
        // cierre best-effort
      }
    }
    this.redis.disconnect();
  }
}

const redisProvider: Provider = {
  provide: REDIS,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): Redis =>
    createRedisClient(config.get('REDIS_URL', { infer: true }), {
      logger: new Logger('Redis'),
      lazyConnect: false,
    }),
};

function grpcProvider(
  token: symbol,
  service: Parameters<typeof createGrpcClient>[0],
  urlKey: keyof Env,
): Provider {
  return {
    provide: token,
    inject: [ConfigService],
    useFactory: (config: ConfigService<Env, true>): GrpcServiceClient =>
      createGrpcClient(service, { url: String(config.get(urlKey, { infer: true })) }),
  };
}

function restProvider(token: symbol, urlKey: keyof Env): Provider {
  return {
    provide: token,
    inject: [ConfigService],
    useFactory: (config: ConfigService<Env, true>): InternalRestClient =>
      new InternalRestClient({
        baseUrl: String(config.get(urlKey, { infer: true })),
        secret: config.get('VEO_INTERNAL_IDENTITY_SECRET', { infer: true }),
      }),
  };
}

const providers: Provider[] = [
  redisProvider,
  grpcProvider(GRPC_IDENTITY, 'identity', 'IDENTITY_GRPC_URL'),
  grpcProvider(GRPC_TRIP, 'trip', 'TRIP_GRPC_URL'),
  grpcProvider(GRPC_PANIC, 'panic', 'PANIC_GRPC_URL'),
  grpcProvider(GRPC_PAYMENT, 'payment', 'PAYMENT_GRPC_URL'),
  grpcProvider(GRPC_MEDIA, 'media', 'MEDIA_GRPC_URL'),
  grpcProvider(GRPC_AUDIT, 'audit', 'AUDIT_GRPC_URL'),
  grpcProvider(GRPC_RATING, 'rating', 'RATING_GRPC_URL'),
  grpcProvider(GRPC_FLEET, 'fleet', 'FLEET_GRPC_URL'),
  restProvider(REST_IDENTITY, 'IDENTITY_URL'),
  restProvider(REST_TRIP, 'TRIP_URL'),
  restProvider(REST_PANIC, 'PANIC_URL'),
  restProvider(REST_PAYMENT, 'PAYMENT_URL'),
  restProvider(REST_MEDIA, 'MEDIA_URL'),
  restProvider(REST_AUDIT, 'AUDIT_URL'),
  restProvider(REST_FLEET, 'FLEET_URL'),
  restProvider(REST_DISPATCH, 'DISPATCH_URL'),
  InfraLifecycle,
];

@Global()
@Module({
  providers,
  exports: providers,
})
export class InfraModule {}
