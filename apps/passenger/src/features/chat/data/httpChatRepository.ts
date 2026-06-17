import {chatMessage, chatMessageList, type HttpClient} from '@veo/api-client';
import type {ChatMessage} from '../domain/entities';
import type {ChatRepository} from '../domain/chatRepository';

/**
 * Implementación REAL de `ChatRepository` contra el public-bff (`/trips/:id/messages`, Ola 2A).
 * Valida las respuestas con los schemas SOBERANOS `chatMessageList` (historial) y `chatMessage`
 * (recurso creado) de `@veo/api-client`.
 */
export class HttpChatRepository implements ChatRepository {
  constructor(private readonly http: HttpClient) {}

  list(tripId: string): Promise<ChatMessage[]> {
    return this.http.get(`/trips/${tripId}/messages`, {
      schema: chatMessageList,
    });
  }

  send(tripId: string, body: string): Promise<ChatMessage> {
    return this.http.post(`/trips/${tripId}/messages`, {
      body: {body},
      schema: chatMessage,
    });
  }
}
