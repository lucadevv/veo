/**
 * GrpcGateway — LECTURAS síncronas BFF→microservicio (FOUNDATION: gRPC para Get*).
 * Crea un cliente gRPC por servicio (perezoso, reutilizable) y firma la identidad del usuario
 * (validada por el BFF vía JWT) en la metadata `x-veo-identity` / `x-veo-identity-sig`.
 */
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  signInternalIdentity,
  INTERNAL_IDENTITY_HEADER,
  INTERNAL_IDENTITY_SIG_HEADER,
  INTERNAL_IDENTITY_SECRET,
  type AuthenticatedUser,
} from '@veo/auth';
import { createGrpcClient, type GrpcServiceClient, type ServiceName } from '@veo/rpc';
import type { Env } from '../config/env.schema';

/** Servicios cuyas lecturas gRPC consume el driver-bff. */
type DriverGrpcService = Extract<
  ServiceName,
  'identity' | 'trip' | 'dispatch' | 'payment' | 'rating' | 'fleet'
>;

const URL_ENV: Record<DriverGrpcService, keyof Env> = {
  identity: 'IDENTITY_GRPC_URL',
  trip: 'TRIP_GRPC_URL',
  dispatch: 'DISPATCH_GRPC_URL',
  payment: 'PAYMENT_GRPC_URL',
  rating: 'RATING_GRPC_URL',
  fleet: 'FLEET_GRPC_URL',
};

@Injectable()
export class GrpcGateway implements OnModuleDestroy {
  private readonly clients = new Map<DriverGrpcService, GrpcServiceClient>();

  constructor(
    private readonly config: ConfigService<Env, true>,
    @Inject(INTERNAL_IDENTITY_SECRET) private readonly secret: string,
  ) {}

  /** Llama un método unario y propaga la identidad firmada por HMAC en la metadata. */
  call<TRes>(
    service: DriverGrpcService,
    method: string,
    request: Record<string, unknown>,
    identity: AuthenticatedUser,
  ): Promise<TRes> {
    const client = this.clientFor(service);
    const { header, signature } = signInternalIdentity(identity, this.secret);
    return client.call<TRes>(method, request, {
      [INTERNAL_IDENTITY_HEADER]: header,
      [INTERNAL_IDENTITY_SIG_HEADER]: signature,
    });
  }

  private clientFor(service: DriverGrpcService): GrpcServiceClient {
    let client = this.clients.get(service);
    if (!client) {
      const url = this.config.getOrThrow<string>(URL_ENV[service]);
      client = createGrpcClient(service, { url });
      this.clients.set(service, client);
    }
    return client;
  }

  onModuleDestroy(): void {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }
}
