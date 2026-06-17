import type { Message } from '../entities';

/** El conductor es siempre el rol DRIVER: sus burbujas van a la derecha en acento cian. */
export function isOwnMessage(message: Message): boolean {
  return message.senderRole === 'DRIVER';
}

/** Marca de tiempo en ms para ordenar; `0` si el `createdAt` no es una fecha válida. */
function timeOf(message: Message): number {
  const ms = Date.parse(message.createdAt);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Ordena los mensajes cronológicamente (ascendente: el más antiguo primero, el más reciente al pie
 * de la conversación). Empata por `id` para un orden estable y determinista cuando dos mensajes
 * comparten `createdAt` (p. ej. el eco del POST y el `chat:message` del socket).
 */
export function sortMessages(messages: readonly Message[]): Message[] {
  return [...messages].sort((a, b) => {
    const delta = timeOf(a) - timeOf(b);
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });
}

/**
 * Inserta un mensaje entrante (socket o eco del POST) en la lista evitando duplicados por `id`,
 * y devuelve la lista ordenada. Si el `id` ya existe, reemplaza la versión previa (el servidor es
 * la fuente de verdad) en lugar de duplicar la burbuja. Idempotente ante reentregas del socket.
 */
export function upsertMessage(messages: readonly Message[], incoming: Message): Message[] {
  const next = messages.filter((m) => m.id !== incoming.id);
  next.push(incoming);
  return sortMessages(next);
}

/**
 * Fusiona el historial REST con los mensajes ya conocidos (los recibidos en vivo) sin duplicar por
 * `id`, dando prioridad a la copia entrante del historial. Devuelve la lista ordenada.
 */
export function mergeMessages(
  existing: readonly Message[],
  history: readonly Message[],
): Message[] {
  const byId = new Map<string, Message>();
  for (const m of existing) {
    byId.set(m.id, m);
  }
  for (const m of history) {
    byId.set(m.id, m);
  }
  return sortMessages([...byId.values()]);
}
