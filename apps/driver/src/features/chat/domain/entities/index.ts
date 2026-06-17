import type { ChatMessage, ChatSenderRole, SendMessageRequest } from '@veo/api-client';

/**
 * Entidades del dominio de chat del viaje (lado conductor, Ola 2A).
 *
 * Un `ChatMessage` lo persiste el driver-bff y llega tanto por REST (`GET/POST /trips/:id/messages`)
 * como en vivo por el evento socket `chat:message`. El `senderRole` lo fija el servidor desde la
 * identidad autenticada, así que es la fuente de verdad para saber de quién es cada burbuja.
 */
export type Message = ChatMessage;
export type MessageRole = ChatSenderRole;
export type SendMessageInput = SendMessageRequest;
