/**
 * ChatService — persistencia de mensajes de chat de un viaje (Ola 2A).
 *
 * Pragmático y soberano: este servicio SOLO persiste y lee mensajes. La autorización (que el usuario
 * pertenece al viaje y que el viaje está activo) y la ENTREGA en tiempo real las hacen los BFFs,
 * reutilizando su infraestructura Socket.IO existente (no se crea una capa WS nueva). El BFF llama a
 * este servicio por REST interno firmado tras verificar la membresía vía gRPC GetTrip.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createEnvelope } from '@veo/events';
import { enqueueOutbox } from '@veo/database';
import { ValidationError, uuidv7 } from '@veo/utils';
import { CHAT_REPO, type ChatRepository } from './chat.repository';
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
    @Inject(CHAT_REPO) private readonly repo: ChatRepository,
    config: ConfigService<Env, true>,
  ) {
    this.maxBodyLength = config.getOrThrow<number>('CHAT_MAX_BODY_LENGTH');
    this.maxPageSize = config.getOrThrow<number>('CHAT_MAX_PAGE_SIZE');
  }

  /** Historial de un viaje en orden cronológico ascendente (más antiguos primero). */
  async listMessages(tripId: string, limit?: number): Promise<ChatMessageView[]> {
    const take = Math.min(Math.max(1, limit ?? this.maxPageSize), this.maxPageSize);
    const rows = await this.repo.findByTrip(tripId, take);
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
    const created = await this.repo.runInTx(async (tx) => {
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

  /**
   * Derecho al olvido (BR-S06, Ley 29733) — borra los mensajes ESCRITOS por la identidad borrada.
   *
   * Borrado duro y no anonimizado: el `body` es texto libre redactado por el usuario (PII en sí
   * mismo); anonimizar solo `senderId` dejaría la PII intacta. Los mensajes del OTRO participante
   * son SU dato y se conservan hasta su propio `user.deleted` o el `trip.pii_erased` del viaje.
   * `user.deleted` trae `userId` y, si era conductor, también `driverId`: borramos ambos lados de la
   * misma identidad. Idempotente: `deleteMany` es no-op si ya no quedan filas.
   */
  async eraseUser(userId: string, driverId?: string): Promise<{ deletedMessages: number }> {
    const senderIds = driverId ? [userId, driverId] : [userId];
    const count = await this.repo.deleteBySenders(senderIds);
    return { deletedMessages: count };
  }

  /**
   * Derecho al olvido (BR-S06) — purga TODA la conversación de un viaje cuya PII fue borrada.
   *
   * `trip.pii_erased` significa que trip-service anonimizó el viaje del pasajero borrado; la
   * conversación cuelga de ese viaje (direcciones, nombres en texto libre) y se purga COMPLETA,
   * ambos lados — mismo criterio que media-service con el video de cabina del viaje.
   * Idempotente: `deleteMany` es no-op si el viaje ya no tiene mensajes.
   */
  async eraseTrip(tripId: string): Promise<{ deletedMessages: number }> {
    const count = await this.repo.deleteByTrip(tripId);
    return { deletedMessages: count };
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
