import type {ChatRepository} from '../repositories/chat-repository';
import type {Message} from '../entities';
import {sortMessages} from '../value-objects/message-list';

/**
 * Caso de uso: cargar el historial del chat de un viaje. Normaliza el orden cronológico ascendente
 * (no confía ciegamente en el orden del servidor) para que la UI pinte las burbujas de antigua a
 * reciente sin lógica de ordenamiento en presentación.
 */
export class GetMessagesUseCase {
  constructor(private readonly chat: ChatRepository) {}

  async execute(tripId: string): Promise<Message[]> {
    const messages = await this.chat.listMessages(tripId);
    return sortMessages(messages);
  }
}

/**
 * Caso de uso: enviar un mensaje del conductor. Recorta espacios y rechaza cuerpos vacíos antes de
 * tocar la red (seguridad/UX: nada de burbujas en blanco mientras maneja). Devuelve el mensaje
 * persistido que el BFF crea (con su `id`/`createdAt` reales).
 */
export class SendMessageUseCase {
  constructor(private readonly chat: ChatRepository) {}

  execute(tripId: string, body: string): Promise<Message> {
    const trimmed = body.trim();
    if (trimmed.length === 0) {
      return Promise.reject(new Error('EMPTY_MESSAGE'));
    }
    return this.chat.sendMessage(tripId, {body: trimmed});
  }
}
