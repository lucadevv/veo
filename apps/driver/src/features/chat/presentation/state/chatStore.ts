import { create } from 'zustand';
import type { Message } from '../../domain';
import { isOwnMessage, mergeMessages, upsertMessage } from '../../domain';

/** Estado del chat de UN viaje: mensajes ordenados + no leídos del pasajero. */
interface TripChat {
  messages: Message[];
  unread: number;
}

const emptyChat: TripChat = { messages: [], unread: 0 };

/**
 * Estado en vivo del chat por viaje (Zustand). Es estado de sesión/UI en vivo (no cacheable como
 * estado de servidor), por eso vive aquí y no en React Query: el `RealtimeManager` empuja los
 * `chat:message` del socket aunque la pantalla de chat no esté montada, para poder pintar el badge
 * de no leídos en el viaje activo.
 *
 * `byTrip` se indexa por `tripId` para no mezclar conversaciones de viajes distintos.
 */
export interface ChatState {
  byTrip: Record<string, TripChat>;
  /** Mensaje entrante por socket (`chat:message`): lo inserta sin duplicar y suma no leídos. */
  receiveMessage(message: Message): void;
  /** Funde el historial REST con lo ya recibido en vivo (sin duplicar por id). */
  hydrate(tripId: string, history: Message[]): void;
  /** Eco del POST propio: lo inserta sin tocar el contador de no leídos. */
  appendOwn(message: Message): void;
  /** Marca el chat como leído (al abrir/estar en la conversación). */
  markRead(tripId: string): void;
  /** Limpia el chat de un viaje (al finalizar/cancelar). */
  clear(tripId: string): void;
}

function chatOf(state: ChatState, tripId: string): TripChat {
  return state.byTrip[tripId] ?? emptyChat;
}

export const useChatStore = create<ChatState>((set, get) => ({
  byTrip: {},

  receiveMessage: (message) => {
    const current = chatOf(get(), message.tripId);
    const messages = upsertMessage(current.messages, message);
    // No incrementamos no leídos por nuestro propio eco (DRIVER) ni si el mensaje ya estaba.
    const isNew = messages.length > current.messages.length;
    const unread = isOwnMessage(message) || !isNew ? current.unread : current.unread + 1;
    set((state) => ({ byTrip: { ...state.byTrip, [message.tripId]: { messages, unread } } }));
  },

  hydrate: (tripId, history) => {
    const current = chatOf(get(), tripId);
    const messages = mergeMessages(current.messages, history);
    set((state) => ({
      byTrip: { ...state.byTrip, [tripId]: { messages, unread: current.unread } },
    }));
  },

  appendOwn: (message) => {
    const current = chatOf(get(), message.tripId);
    const messages = upsertMessage(current.messages, message);
    set((state) => ({
      byTrip: { ...state.byTrip, [message.tripId]: { messages, unread: current.unread } },
    }));
  },

  markRead: (tripId) => {
    const current = chatOf(get(), tripId);
    if (current.unread === 0) {
      return;
    }
    set((state) => ({ byTrip: { ...state.byTrip, [tripId]: { ...current, unread: 0 } } }));
  },

  clear: (tripId) =>
    set((state) => {
      if (!(tripId in state.byTrip)) {
        return state;
      }
      const rest = Object.fromEntries(Object.entries(state.byTrip).filter(([id]) => id !== tripId));
      return { byTrip: rest };
    }),
}));

/** Selector: mensajes ordenados del viaje (lista estable vacía si no hay chat). */
export const selectMessages =
  (tripId: string) =>
  (state: ChatState): Message[] =>
    state.byTrip[tripId]?.messages ?? EMPTY_MESSAGES;

/** Selector: nº de mensajes no leídos del pasajero en el viaje. */
export const selectUnread =
  (tripId: string) =>
  (state: ChatState): number =>
    state.byTrip[tripId]?.unread ?? 0;

/** Referencia estable para evitar re-renders cuando no hay chat para el viaje. */
const EMPTY_MESSAGES: Message[] = [];
