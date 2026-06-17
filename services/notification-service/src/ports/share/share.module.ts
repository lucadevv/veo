/**
 * ShareContactsModule — adapta el cliente gRPC de share-service al puerto TrustedContactsResolver.
 *
 * Lectura síncrona (gRPC) usada por el fan-out de pánico para resolver teléfonos/nombres a partir de
 * los IDs que viajan en el evento Kafka. createGrpcClient/SERVICE_RPC_NAME de @veo/rpc ya conocen
 * share.proto (ShareService.GetTrustedContacts). keepCase:false ⇒ request/response en camelCase.
 */
import { Logger, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createGrpcClient, type GrpcServiceClient } from '@veo/rpc';
import {
  SHARE_CONTACTS_RESOLVER,
  type ResolvedTrustedContact,
  type TrustedContactsResolver,
} from './share-contacts.port';
import type { Env } from '../../config/env.schema';

/** Forma camelCase de la respuesta gRPC (proto-loader con keepCase:false). */
interface TrustedContactWire {
  id: string;
  userId: string;
  phone: string;
  name: string;
  relationship: string;
  otpVerified: boolean;
}
interface TrustedContactsReplyWire {
  contacts?: TrustedContactWire[];
}

/** Adaptador gRPC → puerto. Solo expone {id, phone, name}; el resto del wire no se propaga. */
class GrpcTrustedContactsResolver implements TrustedContactsResolver {
  private readonly logger = new Logger('ShareContactsResolver');

  constructor(private readonly client: GrpcServiceClient) {}

  async resolveByPassenger(passengerId: string): Promise<ResolvedTrustedContact[]> {
    const reply = await this.client.call<TrustedContactsReplyWire>('GetTrustedContacts', {
      userId: passengerId,
    });
    const contacts = (reply.contacts ?? []).filter((c) => c.otpVerified && c.phone.length > 0);
    // Log sin PII (§0.7): solo el conteo, jamás teléfonos/nombres.
    this.logger.debug(
      `GetTrustedContacts(${passengerId}) → ${contacts.length} contactos verificados`,
    );
    return contacts.map((c) => ({ id: c.id, phone: c.phone, name: c.name }));
  }
}

const shareContactsResolverProvider: Provider = {
  provide: SHARE_CONTACTS_RESOLVER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): TrustedContactsResolver =>
    new GrpcTrustedContactsResolver(
      createGrpcClient('share', { url: config.getOrThrow<string>('SHARE_GRPC_URL') }),
    ),
};

@Module({
  providers: [shareContactsResolverProvider],
  exports: [SHARE_CONTACTS_RESOLVER],
})
export class ShareContactsModule {}
