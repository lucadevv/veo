import type { ChatMessage } from './entities';
import { MAX_MESSAGE_LENGTH } from './entities';
import type { ChatRepository } from './chatRepository';

/** Error de dominio para un mensaje inválido antes de tocar la red. */
export class ChatMessageError extends Error {
  constructor(readonly reason: 'empty' | 'tooLong') {
    super(`Mensaje inválido: ${reason}`);
    this.name = 'ChatMessageError';
  }
}

/** Carga el historial inicial del chat de un viaje. */
export class ListMessagesUseCase {
  constructor(private readonly repository: ChatRepository) {}

  execute(tripId: string): Promise<ChatMessage[]> {
    return this.repository.list(tripId);
  }
}

/**
 * Envía un mensaje validando en dominio antes de la red (SRP):
 *  - no vacío (tras recortar espacios),
 *  - no excede el máximo permitido.
 */
export class SendMessageUseCase {
  constructor(private readonly repository: ChatRepository) {}

  execute(tripId: string, rawBody: string): Promise<ChatMessage> {
    const body = rawBody.trim();
    if (body.length === 0) {
      throw new ChatMessageError('empty');
    }
    if (body.length > MAX_MESSAGE_LENGTH) {
      throw new ChatMessageError('tooLong');
    }
    return this.repository.send(tripId, body);
  }
}
