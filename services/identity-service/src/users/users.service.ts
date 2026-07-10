/**
 * UsersService — perfil del usuario (pasajero/conductor) y derecho al olvido (BR-S06).
 * El borrado usa periodo de gracia de 30 días: marca deletionRequestedAt + emite evento; un proceso
 * posterior aplica el tombstone vencida la gracia (data con obligación legal queda exenta).
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createEnvelope } from '@veo/events';
import { ConflictError, NotFoundError } from '@veo/utils';
import { UsersRepository } from './users.repository';
import { type DocumentType } from '../generated/prisma';
import { maskDocument } from '../common/document';
import type { PaymentMethod } from '@veo/shared-types';
import type { Env } from '../config/env.schema';

export interface ProfileView {
  id: string;
  phone: string | null;
  email: string | null;
  name: string | null;
  type: string;
  kycStatus: string;
  photoUrl: string | null;
  /** Tipo de documento del pasajero (DN|CE|PP); null si aún no lo cargó. Owner-only (JWT). */
  documentType: DocumentType | null;
  /** Número de documento del pasajero; null si aún no lo cargó. Es SU dato → se devuelve completo. */
  document: string | null;
  /** Método de pago por defecto (preferencia de UI); null si nunca lo eligió. Validado al escribir. */
  defaultPaymentMethod: PaymentMethod | null;
  deletionRequestedAt: Date | null;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  private readonly graceDays: number;

  constructor(
    private readonly repo: UsersRepository,
    config: ConfigService<Env, true>,
  ) {
    this.graceDays = config.getOrThrow<number>('DELETION_GRACE_DAYS');
  }

  async getProfile(userId: string): Promise<ProfileView> {
    const user = await this.repo.findUserById(userId);
    if (!user || user.deletedAt) throw new NotFoundError('Usuario no encontrado');
    return this.view(user);
  }

  async updateProfile(
    userId: string,
    data: {
      email?: string;
      photoUrl?: string;
      name?: string;
      documentType?: DocumentType;
      document?: string;
      defaultPaymentMethod?: PaymentMethod;
    },
  ): Promise<ProfileView> {
    const user = await this.repo.findUserById(userId);
    if (!user || user.deletedAt) throw new NotFoundError('Usuario no encontrado');

    const nextDocumentType = data.documentType ?? user.documentType;
    const nextDocument = data.document ?? user.document;
    const documentChanged =
      (data.documentType !== undefined && data.documentType !== user.documentType) ||
      (data.document !== undefined && data.document !== user.document);

    const updated = await this.repo.updateUser(userId, {
      email: data.email ?? user.email,
      photoUrl: data.photoUrl ?? user.photoUrl,
      name: data.name ?? user.name,
      documentType: nextDocumentType,
      document: nextDocument,
      defaultPaymentMethod: data.defaultPaymentMethod ?? user.defaultPaymentMethod,
    });

    // AUDIT: cambio de documento (PII). Se registra el evento con el valor MASCARADO —
    // NUNCA el documento completo en el log (Ley 29733).
    if (documentChanged) {
      this.logger.log(
        `audit profile.document_changed userId=${userId} documentType=${nextDocumentType ?? '∅'} document=${maskDocument(nextDocument)}`,
      );
    }

    return this.view(updated);
  }

  /** Solicita el borrado: inicia la gracia y emite user.deletion_requested. */
  async requestDeletion(userId: string): Promise<{ graceUntil: string }> {
    const now = new Date();
    const graceUntil = new Date(now.getTime() + this.graceDays * 24 * 60 * 60 * 1000);

    await this.repo.runInTransaction(async (tx) => {
      const user = await this.repo.findUserByIdTx(tx, userId);
      if (!user || user.deletedAt) throw new NotFoundError('Usuario no encontrado');
      if (user.deletionRequestedAt) throw new ConflictError('Ya existe una solicitud de borrado');
      await this.repo.updateUserTx(tx, userId, { deletionRequestedAt: now });
      await this.repo.enqueueOutbox(
        tx,
        createEnvelope({
          eventType: 'user.deletion_requested',
          producer: 'identity-service',
          payload: { userId, requestedAt: now.toISOString(), graceUntil: graceUntil.toISOString() },
        }),
        userId,
      );
    });

    return { graceUntil: graceUntil.toISOString() };
  }

  async cancelDeletion(userId: string): Promise<void> {
    await this.repo.updateUser(userId, { deletionRequestedAt: null });
  }

  private view(user: {
    id: string;
    phone: string | null;
    email: string | null;
    name: string | null;
    type: string;
    kycStatus: string;
    photoUrl: string | null;
    documentType: DocumentType | null;
    document: string | null;
    defaultPaymentMethod: string | null;
    deletionRequestedAt: Date | null;
  }): ProfileView {
    return {
      id: user.id,
      phone: user.phone,
      email: user.email,
      name: user.name,
      type: user.type,
      kycStatus: user.kycStatus,
      photoUrl: user.photoUrl,
      documentType: user.documentType,
      document: user.document,
      // El borde DTO valida @IsEnum(PaymentMethod) al escribir → el valor guardado es siempre válido.
      defaultPaymentMethod: user.defaultPaymentMethod as PaymentMethod | null,
      deletionRequestedAt: user.deletionRequestedAt,
    };
  }
}
