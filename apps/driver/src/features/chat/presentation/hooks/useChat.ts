import {useEffect} from 'react';
import {useMutation, useQuery} from '@tanstack/react-query';
import {useRepositories} from '../../../../core/di/useDi';
import {GetMessagesUseCase, SendMessageUseCase, type Message} from '../../domain';
import {selectMessages, selectUnread, useChatStore} from '../state/chatStore';

/** Clave de caché del historial de chat de un viaje. */
export const chatHistoryQueryKey = (tripId: string) => ['chat', tripId, 'history'] as const;

/**
 * Carga el historial del chat (REST) y lo funde en el store en vivo. El store es la fuente única que
 * la UI renderiza, así que el historial y los mensajes del socket conviven sin duplicarse.
 */
export function useChatHistory(tripId: string) {
  const {chat} = useRepositories();
  const hydrate = useChatStore(s => s.hydrate);

  const query = useQuery({
    queryKey: chatHistoryQueryKey(tripId),
    queryFn: () => new GetMessagesUseCase(chat).execute(tripId),
  });

  useEffect(() => {
    if (query.data) {
      hydrate(tripId, query.data);
    }
  }, [query.data, hydrate, tripId]);

  return query;
}

/**
 * Mutación: enviar un mensaje del conductor. El BFF devuelve el mensaje persistido; lo insertamos en
 * el store al instante (eco optimista del lado servidor) sin esperar al `chat:message` del socket,
 * que de todos modos será idempotente (mismo `id`).
 */
export function useSendMessage(tripId: string) {
  const {chat} = useRepositories();
  const appendOwn = useChatStore(s => s.appendOwn);

  return useMutation({
    mutationFn: (body: string) => new SendMessageUseCase(chat).execute(tripId, body),
    onSuccess: (message: Message) => appendOwn(message),
  });
}

/** Mensajes en vivo del viaje (ordenados), provenientes del store de chat. */
export function useChatMessages(tripId: string): Message[] {
  return useChatStore(selectMessages(tripId));
}

/** Nº de mensajes no leídos del pasajero en el viaje (para el badge en TripActive). */
export function useChatUnread(tripId: string): number {
  return useChatStore(selectUnread(tripId));
}

/** Marca el chat del viaje como leído (al abrir/estar en la conversación). */
export function useMarkChatRead(tripId: string): () => void {
  const markRead = useChatStore(s => s.markRead);
  return () => markRead(tripId);
}
