// Entidades de dominio del Chat del viaje (Ola 2A). Contrato soberano en `@veo/api-client`.
export type {ChatMessage, ChatSenderRole} from '@veo/api-client';
import type {ChatMessage} from '@veo/api-client';

/** Longitud máxima del cuerpo de un mensaje (defensa de UI; el bff es la autoridad). */
export const MAX_MESSAGE_LENGTH = 500;

/** Estados de viaje terminales: con ellos el chat queda deshabilitado (solo lectura). */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'COMPLETED',
  'CANCELLED',
]);

/** True si el viaje sigue activo (no terminado) y, por tanto, el chat acepta envíos. */
export function isChatActive(status: string | null | undefined): boolean {
  return status != null && !TERMINAL_STATUSES.has(status);
}

/** True si el mensaje lo envió el pasajero (este usuario), para alinearlo a la derecha. */
export function isOwnMessage(
  message: Pick<ChatMessage, 'senderRole'>,
): boolean {
  return message.senderRole === 'PASSENGER';
}

/**
 * Mezcla el historial con los mensajes entrantes del socket, deduplicando por id y ordenando por
 * `createdAt` ascendente. Pura y determinista: la pantalla la usa para tener una única lista estable
 * sin importar el orden de llegada (REST inicial + tiempo real).
 */
export function mergeMessages(
  history: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const message of [...history, ...incoming]) {
    byId.set(message.id, message);
  }
  return Array.from(byId.values()).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}
