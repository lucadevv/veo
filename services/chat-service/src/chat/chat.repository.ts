/**
 * Puerto + adaptador Prisma de la persistencia de mensajes de chat (FOUNDATION §10: cada feature
 * accede a Prisma SOLO a través de su repository, patrón unit-of-work). El ChatService depende de la
 * INTERFAZ (CHAT_REPO), NO de Prisma: la lógica de negocio (validación de cuerpo, armado del envelope,
 * criterio de borrado) vive en el service; este adaptador es el único dueño del cliente Prisma.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { Prisma, type Message } from '../generated/prisma';

/** Token DI del puerto (inyección por interfaz, no por clase concreta). */
export const CHAT_REPO = Symbol('CHAT_REPO');

/** Cliente de transacción entregado a `runInTx` (crea el mensaje + encola el outbox en la MISMA tx). */
export type ChatTx = Prisma.TransactionClient;

/** Puerto: el servicio depende de esto, no de Prisma. */
export interface ChatRepository {
  /** Mensajes de un viaje en orden cronológico ascendente (más antiguos primero). */
  findByTrip(tripId: string, take: number): Promise<Message[]>;
  /** Abre una transacción de escritura y entrega el cliente tx al callback (create + outbox). */
  runInTx<T>(fn: (tx: ChatTx) => Promise<T>): Promise<T>;
  /** Borra los mensajes ESCRITOS por las identidades dadas; devuelve cuántos borró (idempotente). */
  deleteBySenders(senderIds: string[]): Promise<number>;
  /** Borra TODA la conversación de un viaje; devuelve cuántos borró (idempotente). */
  deleteByTrip(tripId: string): Promise<number>;
}

@Injectable()
export class PrismaChatRepository implements ChatRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByTrip(tripId: string, take: number): Promise<Message[]> {
    return this.prisma.read.message.findMany({
      where: { tripId },
      orderBy: { createdAt: 'asc' },
      take,
    });
  }

  async runInTx<T>(fn: (tx: ChatTx) => Promise<T>): Promise<T> {
    return this.prisma.write.$transaction(fn);
  }

  async deleteBySenders(senderIds: string[]): Promise<number> {
    const { count } = await this.prisma.write.message.deleteMany({
      where: { senderId: { in: senderIds } },
    });
    return count;
  }

  async deleteByTrip(tripId: string): Promise<number> {
    const { count } = await this.prisma.write.message.deleteMany({ where: { tripId } });
    return count;
  }
}
