/**
 * Controlador gRPC de share (paquete veo.share.v1.ShareService).
 * Lectura síncrona de contactos de confianza para notification/panic.
 */
import { Controller, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus, type Metadata } from '@grpc/grpc-js';
import {
  verifyGrpcIdentity,
  INTERNAL_IDENTITY_ALLOWED_AUDIENCES,
  type InternalAudience,
} from '@veo/auth';
import { ContactsService } from '../contacts/contacts.service';
import type { Env } from '../config/env.schema';

interface GetTrustedContactsRequest {
  userId: string;
  /** Vista del DUEÑO (pantalla de contactos): incluye pendientes de OTP. Fan-out de pánico lo omite. */
  includeUnverified?: boolean;
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
  private readonly secret: string;

  constructor(
    private readonly contacts: ContactsService,
    config: ConfigService<Env, true>,
    @Inject(INTERNAL_IDENTITY_ALLOWED_AUDIENCES)
    private readonly allowedAudiences: readonly InternalAudience[],
  ) {
    this.secret = config.get('INTERNAL_IDENTITY_SECRET', { infer: true });
  }

  @GrpcMethod('ShareService', 'GetTrustedContacts')
  async getTrustedContacts(
    { userId, includeUnverified }: GetTrustedContactsRequest,
    metadata: Metadata,
  ): Promise<TrustedContactsReply> {
    const identity = verifyGrpcIdentity(metadata, this.secret, {
      allowedAudiences: this.allowedAudiences,
    });
    if (!identity) {
      throw new RpcException({
        code: GrpcStatus.UNAUTHENTICATED,
        message: 'Identidad interna inválida o ausente',
      });
    }
    // Vista del DUEÑO (includeUnverified): TODOS sus contactos — sin esto, un contacto recién
    // creado (OTP pendiente) era INVISIBLE en la app y el flujo de verificación no tenía cierre
    // (bug cazado en sim 2026-07-15). El fan-out de pánico omite el flag → solo verificados.
    const verified = includeUnverified
      ? await this.contacts.list(userId)
      : await this.contacts.listVerified(userId);
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
