/**
 * Puerto + adaptador Prisma de los contactos de confianza (FOUNDATION §10: el repositorio es el ÚNICO
 * dueño de Prisma; ningún *.service.ts toca `this.prisma` directo). Espeja el molde del PanicRepository
 * (token DI Symbol + interfaz + adaptador con read/write split). Sin transacciones: son operaciones
 * atómicas de una sola fila; el cool-down vive en Redis (fuera de este puerto), no en la BD.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type TrustedContact } from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const CONTACTS_REPO = Symbol('CONTACTS_REPO');

/** Puerto: el ContactsService depende de esto, NO de Prisma. */
export interface ContactsRepository {
  /** Contactos del usuario ordenados por antigüedad (read). */
  listByUser(userId: string): Promise<TrustedContact[]>;
  /** Contactos verificados del usuario ordenados por antigüedad (read). */
  listVerifiedByUser(userId: string): Promise<TrustedContact[]>;
  /** Cantidad de contactos del usuario (read), para validar el cupo. */
  countByUser(userId: string): Promise<number>;
  /** Lee un contacto por id (read); el service valida que pertenezca al usuario. `null` si no existe. */
  findById(contactId: string): Promise<TrustedContact | null>;
  /** Alta de contacto no verificado (write). */
  create(data: Prisma.TrustedContactUncheckedCreateInput): Promise<TrustedContact>;
  /** Marca el contacto como verificado en `verifiedAt` (write). */
  markOtpVerified(contactId: string, verifiedAt: Date): Promise<TrustedContact>;
  /** Baja de contacto (write). */
  delete(contactId: string): Promise<void>;
}

@Injectable()
export class PrismaContactsRepository implements ContactsRepository {
  constructor(private readonly prisma: PrismaService) {}

  listByUser(userId: string): Promise<TrustedContact[]> {
    return this.prisma.read.trustedContact.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
  }

  listVerifiedByUser(userId: string): Promise<TrustedContact[]> {
    return this.prisma.read.trustedContact.findMany({
      where: { userId, otpVerifiedAt: { not: null } },
      orderBy: { createdAt: 'asc' },
    });
  }

  countByUser(userId: string): Promise<number> {
    return this.prisma.read.trustedContact.count({ where: { userId } });
  }

  findById(contactId: string): Promise<TrustedContact | null> {
    return this.prisma.read.trustedContact.findUnique({ where: { id: contactId } });
  }

  create(data: Prisma.TrustedContactUncheckedCreateInput): Promise<TrustedContact> {
    return this.prisma.write.trustedContact.create({ data });
  }

  markOtpVerified(contactId: string, verifiedAt: Date): Promise<TrustedContact> {
    return this.prisma.write.trustedContact.update({
      where: { id: contactId },
      data: { otpVerifiedAt: verifiedAt },
    });
  }

  async delete(contactId: string): Promise<void> {
    await this.prisma.write.trustedContact.delete({ where: { id: contactId } });
  }
}
