import type {HttpClient} from '@veo/api-client';
import { chatMessage, chatMessageList} from '@veo/api-client';
import type {ChatRepository, Message, SendMessageInput} from '../../domain';

/** Implementación HTTP del `ChatRepository` contra el driver-bff. */
export class HttpChatRepository implements ChatRepository {
  constructor(private readonly http: HttpClient) {}

  listMessages(tripId: string): Promise<Message[]> {
    return this.http.get(`/trips/${tripId}/messages`, {schema: chatMessageList});
  }

  sendMessage(tripId: string, input: SendMessageInput): Promise<Message> {
    return this.http.post(`/trips/${tripId}/messages`, {body: input, schema: chatMessage});
  }
}
