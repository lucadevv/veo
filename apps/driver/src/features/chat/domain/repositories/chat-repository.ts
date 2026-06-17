import type { Message, SendMessageInput } from '../entities';

/**
 * Contrato del repositorio de chat del viaje (capa domain). Implementación concreta en `data/`.
 * El historial y el envío van por REST contra el driver-bff; los mensajes en vivo llegan por el
 * socket `/driver` (evento `chat:message`) y los engancha la capa de realtime, no este repositorio.
 */
export interface ChatRepository {
  /** GET /trips/:id/messages — historial del chat (orden cronológico ascendente). */
  listMessages(tripId: string): Promise<Message[]>;
  /** POST /trips/:id/messages — envía un mensaje del conductor; el BFF devuelve el mensaje creado. */
  sendMessage(tripId: string, input: SendMessageInput): Promise<Message>;
}
