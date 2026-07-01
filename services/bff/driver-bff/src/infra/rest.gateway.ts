/**
 * RestGateway — COMANDOS BFF→microservicio por REST interno firmado con HMAC (FOUNDATION §10).
 * Un InternalRestClient por servicio downstream, con baseUrl `<url>/api/v1`. El cliente firma la
 * identidad del usuario y nunca reenvía el JWT crudo.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  INTERNAL_IDENTITY_SECRET,
  INTERNAL_IDENTITY_AUDIENCE,
  type InternalAudience,
} from '@veo/auth';
import { InternalRestClient } from '@veo/rpc';
import type { Env } from '../config/env.schema';

/** Servicios a los que el driver-bff envía comandos. `payouts` comparte proceso con `payment`. */
export type DownstreamRestService =
  | 'identity'
  | 'trip'
  | 'dispatch'
  | 'payment'
  | 'payouts'
  | 'notification'
  | 'fleet'
  | 'media'
  | 'chat'
  | 'booking';

const URL_ENV: Record<DownstreamRestService, keyof Env> = {
  identity: 'IDENTITY_URL',
  trip: 'TRIP_URL',
  dispatch: 'DISPATCH_URL',
  payment: 'PAYMENT_URL',
  payouts: 'PAYOUTS_URL',
  notification: 'NOTIFICATION_URL',
  fleet: 'FLEET_URL',
  media: 'MEDIA_URL',
  chat: 'CHAT_URL',
  booking: 'BOOKING_SERVICE_URL',
};

@Injectable()
export class RestGateway {
  private readonly clients = new Map<DownstreamRestService, InternalRestClient>();

  constructor(
    private readonly config: ConfigService<Env, true>,
    @Inject(INTERNAL_IDENTITY_SECRET) private readonly secret: string,
    @Inject(INTERNAL_IDENTITY_AUDIENCE) private readonly audience: InternalAudience,
  ) {}

  /** Devuelve (creando si hace falta) el cliente REST interno para un servicio downstream. */
  client(service: DownstreamRestService): InternalRestClient {
    let client = this.clients.get(service);
    if (!client) {
      const base = this.config.getOrThrow<string>(URL_ENV[service]).replace(/\/$/, '');
      client = new InternalRestClient({
        baseUrl: `${base}/api/v1`,
        secret: this.secret,
        audience: this.audience,
        timeoutMs: this.config.getOrThrow<number>('DOWNSTREAM_TIMEOUT_MS'),
      });
      this.clients.set(service, client);
    }
    return client;
  }
}
