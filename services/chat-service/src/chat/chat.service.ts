/**
 * ChatService — persistencia de mensajes de chat de un viaje (Ola 2A).
 *
 * Pragmático y soberano: este servicio SOLO persiste y lee mensajes. La autorización (que el usuario
 * pertenece al viaje y que el viaje está activo) y la ENTREGA en tiempo real las hacen los BFFs,
 * reutilizando su infraestructura Socket.IO existente (no se crea una capa WS nueva). El BFF llama a
 * este servicio por REST interno firmado tras verificar la membresía vía gRPC GetTrip.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createEnvelope } from '@veo/events';
import { enqueueOutbox } from '@veo/database';
import { ValidationError, uuidv7 } from '@veo/utils';
import { PrismaService } from '../infra/prisma.service';
import type { Message, SenderRole } from '../generated/prisma';
import type { Env } from '../config/env.schema';

export interface ChatMessageView {
  id: string;
  tripId: string;
  senderId: string;
  senderRole: SenderRole;
  body: string;
  createdAt: string;
}

export interface PostMessageInput {
  tripId: string;
  senderId: string;
  senderRole: SenderRole;
  body: string;
  /**
   * Pasajero del viaje (lo conoce el BFF vía gRPC GetTrip). Solo se usa para ENRIQUECER el evento
   * chat.message_sent → notification-service. NO se persiste (chat solo es dueño del mensaje).
   */
  passengerId?: string;
}

@Injectable()
export class ChatService {
  private readonly maxBodyLength: number;
  private readonly maxPageSize: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.maxBodyLength = config.getOrThrow<number>('CHAT_MAX_BODY_LENGTH');
    this.maxPageSize = config.getOrThrow<number>('CHAT_MAX_PAGE_SIZE');
  }

  /** Historial de un viaje en orden cronológico ascendente (más antiguos primero). */
  async listMessages(tripId: string, limit?: number): Promise<ChatMessageView[]> {
    const take = Math.min(Math.max(1, limit ?? this.maxPageSize), this.maxPageSize);
    const rows = await this.prisma.read.message.findMany({
      where: { tripId },
      orderBy: { createdAt: 'asc' },
      take,
    });
    return rows.map((m) => this.view(m));
  }

  /** Persiste un mensaje del viaje. El BFF ya validó membresía y estado activo del viaje. */
  async postMessage(input: PostMessageInput): Promise<ChatMessageView> {
    const body = input.body.trim();
    if (body.length === 0) throw new ValidationError('El mensaje no puede estar vacío');
    if (body.length > this.maxBodyLength) {
      throw new ValidationError(`El mensaje excede ${this.maxBodyLength} caracteres`);
    }
    // Mensaje + evento chat.message_sent en la MISMA transacción (outbox). El relay lo publica a
    // Kafka; ambos BFFs lo consumen y lo emiten por Socket.IO a la sala del viaje (entrega RT).
    const created = await this.prisma.write.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          id: uuidv7(),
          tripId: input.tripId,
          senderId: input.senderId,
          senderRole: input.senderRole,
          body,
        },
      });
      const envelope = createEnvelope({
        eventType: 'chat.message_sent',
        producer: 'chat-service',
        payload: {
          messageId: message.id,
          tripId: message.tripId,
          senderId: message.senderId,
          senderRole: message.senderRole,
          body: message.body,
          createdAt: message.createdAt.toISOString(),
          // ENRIQUECIDO (no persistido): habilita el push al pasajero cuando escribe el conductor.
          passengerId: input.passengerId,
        },
      });
      await enqueueOutbox(tx, envelope, message.tripId);
      return message;
    });
    return this.view(created);
  }

  private view(m: Message): ChatMessageView {
    return {
      id: m.id,
      tripId: m.tripId,
      senderId: m.senderId,
      senderRole: m.senderRole,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
    };
  }
}
