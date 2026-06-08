/**
 * Controlador gRPC de share (paquete veo.share.v1.ShareService).
 * Lectura síncrona de contactos de confianza para notification/panic.
 */
import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { ContactsService } from '../contacts/contacts.service';

interface GetTrustedContactsRequest {
  userId: string;
}
interface TrustedContactReply {
  id: string;
  userId: string;
  phone: string;
  name: string;
  relationship: string;
  otpVerified: boolean;
}
interface TrustedContactsReply {
  contacts: TrustedContactReply[];
}

@Controller()
export class ShareGrpcController {
  constructor(private readonly contacts: ContactsService) {}

  @GrpcMethod('ShareService', 'GetTrustedContacts')
  async getTrustedContacts({ userId }: GetTrustedContactsRequest): Promise<TrustedContactsReply> {
    const verified = await this.contacts.listVerified(userId);
    return {
      contacts: verified.map((c) => ({
        id: c.id,
        userId,
        phone: c.phone,
        name: c.name,
        relationship: c.relationship,
        otpVerified: c.verified,
      })),
    };
  }
}
