/**
 * ContactsService — gestión de contactos de confianza (BR-I06):
 *  - Máximo 3 por usuario.
 *  - Cada contacto requiere OTP enviado a su teléfono (puerto SMS) y verificación (otpVerifiedAt).
 *  - Modificar la lista (alta/baja) tiene un cool-down de 24h.
 * El cool-down se ancla en un marcador Redis por usuario (sobrevive a las bajas, que borran filas).
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { uuidv7, parseOrThrow, peruPhoneSchema, NotFoundError } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import { REDIS } from '../infra/redis';
import { ContactOtpService } from './contact-otp.service';
import { SMS_SENDER, type SmsSender } from '../ports/sms/sms.port';
import { assertContactQuota, assertContactsCooldown } from './contacts.rules';
import type { Env } from '../config/env.schema';

export interface ContactView {
  id: string;
  phone: string;
  email: string | null;
  name: string;
  relationship: string;
  verified: boolean;
  createdAt: Date;
}

export interface AddContactInput {
  phone: string;
  name: string;
  relationship: string;
  email?: string;
}

@Injectable()
export class ContactsService {
  private readonly maxContacts: number;
  private readonly cooldownMs: number;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly otp: ContactOtpService,
    @Inject(SMS_SENDER) private readonly sms: SmsSender,
    config: ConfigService<Env, true>,
  ) {
    this.maxContacts = config.getOrThrow<number>('MAX_TRUSTED_CONTACTS');
    this.cooldownMs = config.getOrThrow<number>('CONTACT_MODIFY_COOLDOWN_HOURS') * 3_600_000;
  }

  private cooldownKey(userId: string): string {
    return `veo:share:contacts:lastmod:${userId}`;
  }

  private async lastModifiedAt(userId: string): Promise<Date | null> {
    const raw = await this.redis.get(this.cooldownKey(userId));
    return raw ? new Date(Number(raw)) : null;
  }

  private async markModified(userId: string, now = Date.now()): Promise<void> {
    // TTL = cool-down: pasado ese tiempo el marcador expira y se puede volver a modificar.
    await this.redis.set(
      this.cooldownKey(userId),
      String(now),
      'PX',
      this.cooldownMs,
    );
  }

  /** Lista los contactos de confianza del usuario. */
  async list(userId: string): Promise<ContactView[]> {
    const rows = await this.prisma.read.trustedContact.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((c) => this.view(c));
  }

  /**
   * Alta de contacto: valida cupo (max 3) y cool-down, crea el contacto (no verificado),
   * emite un OTP y lo envía por SMS al teléfono del contacto.
   */
  async add(userId: string, input: AddContactInput): Promise<{ contact: ContactView; otpSent: true }> {
    const phone = parseOrThrow(peruPhoneSchema, input.phone, 'phone');

    assertContactsCooldown(await this.lastModifiedAt(userId), this.cooldownMs);
    const count = await this.prisma.read.trustedContact.count({ where: { userId } });
    assertContactQuota(count, this.maxContacts);

    const contact = await this.prisma.write.trustedContact.create({
      data: {
        id: uuidv7(),
        userId,
        phone,
        email: input.email,
        name: input.name,
        relationship: input.relationship,
      },
    });

    const code = await this.otp.issue(contact.id);
    await this.sms.send(
      phone,
      `Te agregaron como contacto de confianza en VEO. Tu código de verificación es ${code} (válido 5 min). No lo compartas.`,
    );

    await this.markModified(userId);
    return { contact: this.view(contact), otpSent: true };
  }

  /** Verifica el OTP del contacto y lo marca como verificado. No cuenta para el cool-down. */
  async verifyOtp(userId: string, contactId: string, code: string): Promise<ContactView> {
    const contact = await this.prisma.read.trustedContact.findUnique({ where: { id: contactId } });
    if (contact?.userId !== userId) throw new NotFoundError('Contacto no encontrado');

    await this.otp.verify(contactId, code);

    const updated = await this.prisma.write.trustedContact.update({
      where: { id: contactId },
      data: { otpVerifiedAt: new Date() },
    });
    return this.view(updated);
  }

  /** Reenvía el OTP a un contacto pendiente de verificación. */
  async resendOtp(userId: string, contactId: string): Promise<{ otpSent: true }> {
    const contact = await this.prisma.read.trustedContact.findUnique({ where: { id: contactId } });
    if (contact?.userId !== userId) throw new NotFoundError('Contacto no encontrado');
    const code = await this.otp.issue(contactId);
    await this.sms.send(contact.phone, `Tu código de verificación de contacto VEO es ${code} (válido 5 min).`);
    return { otpSent: true };
  }

  /** Baja de contacto: aplica cool-down de modificación de la lista. */
  async remove(userId: string, contactId: string): Promise<void> {
    assertContactsCooldown(await this.lastModifiedAt(userId), this.cooldownMs);
    const contact = await this.prisma.read.trustedContact.findUnique({ where: { id: contactId } });
    if (contact?.userId !== userId) throw new NotFoundError('Contacto no encontrado');

    await this.prisma.write.trustedContact.delete({ where: { id: contactId } });
    await this.markModified(userId);
  }

  /** Contactos verificados de un usuario (lo usa el flujo de pánico y el gRPC). */
  async listVerified(userId: string): Promise<ContactView[]> {
    const rows = await this.prisma.read.trustedContact.findMany({
      where: { userId, otpVerifiedAt: { not: null } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((c) => this.view(c));
  }

  private view(c: {
    id: string;
    phone: string;
    email: string | null;
    name: string;
    relationship: string;
    otpVerifiedAt: Date | null;
    createdAt: Date;
  }): ContactView {
    return {
      id: c.id,
      phone: c.phone,
      email: c.email,
      name: c.name,
      relationship: c.relationship,
      verified: c.otpVerifiedAt !== null,
      createdAt: c.createdAt,
    };
  }
}
